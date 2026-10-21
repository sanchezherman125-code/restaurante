import { useEffect, useState } from "react";
import { disablePushNotifications, enablePushNotifications, hasPushSubscription, supportsWebPush } from "../notifications/push";
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
    <div className="notification-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notification-settings-title">
        <div className="notification-panel-heading">
          <div><strong id="notification-settings-title">Notificaciones</strong><p>Preferencias de este usuario y dispositivo</p></div>
          <button type="button" className="close" aria-label="Cerrar ajustes de notificaciones" onClick={onClose}>✕</button>
        </div>
        <label className="notification-setting">
          <span><strong>Sonido</strong><small>Avisos con tonos distintos según el evento</small></span>
          <input type="checkbox" checked={soundEnabled} onChange={() => void toggleSound()} />
        </label>
        <label className="notification-setting volume-setting">
          <span><strong>Volumen</strong><small>{Math.round(volume * 100)}%</small></span>
          <input aria-label="Volumen de notificaciones" type="range" min="0" max="1" step="0.05" value={volume}
            onChange={(event) => updatePreferences(userId, { volume: Number(event.target.value) })} />
        </label>
        <button className="btn secondary block notification-test" onClick={async () => {
          if (await unlockNotificationAudio()) playNotificationSound("command");
          else setPushStatus("El audio se desbloquea al probarlo en una interacción directa del usuario.");
        }}>Probar sonido</button>
        <label className="notification-setting">
          <span><strong>Vibración</strong><small>Si el dispositivo y navegador la admiten</small></span>
          <input type="checkbox" checked={vibrationEnabled} onChange={(event) => {
            updatePreferences(userId, { vibrationEnabled: event.target.checked });
            if (event.target.checked) vibrateNotification([70, 50, 70]);
          }} />
        </label>
        <div className="notification-setting push-setting">
          <span><strong>Avisos del sistema</strong><small>{supportsWebPush() ? "Para recibir avisos con la app en segundo plano" : "No disponible en este navegador"}</small></span>
          <button className={`btn ${pushEnabled ? "secondary" : "primary"}`} disabled={!supportsWebPush()} onClick={() => void togglePush()}>
            {pushEnabled ? "Desactivar" : "Activar"}
          </button>
        </div>
        {pushStatus ? <p className="notification-status" role="status">{pushStatus}</p> : null}
        {typeof Notification !== "undefined" && Notification.permission === "denied" ?
          <p className="notification-status">El permiso está bloqueado por el navegador; la app no puede volver a solicitarlo automáticamente.</p> : null}
      </section>
    </div>
  );
}
