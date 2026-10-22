import { useEffect, useState } from "react";
import { disablePushNotifications, enablePushNotifications, hasPushSubscription, supportsWebPush } from "../notifications/push";
import { Modal } from "./Modal";
import { unlockNotificationAudio, playNotificationSound, useUi, vibrateNotification } from "../stores/ui";

export function NotificationSettings({ userId, onClose }: { userId: string; onClose: () => void }) {
  const soundEnabled = useUi((state) => state.soundEnabled);
  const volume = useUi((state) => state.volume);
  const vibrationEnabled = useUi((state) => state.vibrationEnabled);
  const pushEnabled = useUi((state) => state.pushEnabled);
  const updatePreferences = useUi((state) => state.updatePreferences);
  const [pushStatus, setPushStatus] = useState("");

  useEffect(() => {
    let active = true;
    void hasPushSubscription().then((enabled) => {
      if (active && enabled !== pushEnabled) updatePreferences(userId, { pushEnabled: enabled });
    });
    return () => { active = false; };
  }, [userId, pushEnabled, updatePreferences]);

  const toggleSound = async () => {
    const enabled = !soundEnabled;
    updatePreferences(userId, { soundEnabled: enabled });
    if (enabled && await unlockNotificationAudio()) playNotificationSound("ready");
  };

  const togglePush = async () => {
    setPushStatus("");
    if (pushEnabled) {
      await disablePushNotifications();
      updatePreferences(userId, { pushEnabled: false });
      setPushStatus("Notificaciones push desactivadas en este dispositivo.");
      return;
    }
    const result = await enablePushNotifications();
    updatePreferences(userId, { pushEnabled: result === "enabled" });
    setPushStatus({
      enabled: "Notificaciones del sistema activadas.",
      denied: "Permiso denegado. Cámbielo en los ajustes del navegador.",
      unsupported: "Este navegador no ofrece Web Push en esta instalación.",
      unavailable: "No se pudo activar. Compruebe la conexión y la configuración del servidor.",
    }[result]);
  };

  return (
    <Modal title="Notificaciones" onClose={onClose}>
      <p className="hint" style={{ marginTop: "calc(var(--s2) * -1)", marginBottom: "var(--s3)" }}>Preferencias de este usuario y de este dispositivo.</p>
      <div className="settings-list">
        <label className="setting">
          <span><strong>Sonido</strong><small>Tonos distintos según el evento</small></span>
          <input className="switch" type="checkbox" role="switch" checked={soundEnabled} onChange={() => void toggleSound()} />
        </label>
        <label className="setting">
          <span><strong>Volumen</strong><small>{Math.round(volume * 100)}%</small></span>
          <input aria-label="Volumen de notificaciones" type="range" min="0" max="1" step="0.05" value={volume}
            onChange={(event) => updatePreferences(userId, { volume: Number(event.target.value) })} />
        </label>
        <button className="btn secondary block" onClick={async () => {
          if (await unlockNotificationAudio()) playNotificationSound("command");
          else setPushStatus("El audio se desbloquea al probarlo en una interacción directa del usuario.");
        }}>Probar sonido</button>
        <label className="setting">
          <span><strong>Vibración</strong><small>Si el dispositivo y el navegador la admiten</small></span>
          <input className="switch" type="checkbox" role="switch" checked={vibrationEnabled} onChange={(event) => {
            updatePreferences(userId, { vibrationEnabled: event.target.checked });
            if (event.target.checked) vibrateNotification([70, 50, 70]);
          }} />
        </label>
        <div className="setting">
          <span><strong>Avisos del sistema</strong><small>{supportsWebPush() ? "Para recibir avisos con la app en segundo plano" : "No disponible en este navegador"}</small></span>
          <button className={`btn small ${pushEnabled ? "secondary" : ""}`} disabled={!supportsWebPush()} onClick={() => void togglePush()}>
            {pushEnabled ? "Desactivar" : "Activar"}
          </button>
        </div>
      </div>
      {pushStatus ? <p className="hint" role="status" style={{ marginTop: "var(--s3)" }}>{pushStatus}</p> : null}
      {typeof Notification !== "undefined" && Notification.permission === "denied" ?
        <p className="hint" style={{ marginTop: "var(--s3)" }}>El permiso está bloqueado por el navegador; la app no puede volver a solicitarlo automáticamente.</p> : null}
    </Modal>
  );
}
