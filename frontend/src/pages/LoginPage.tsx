import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useSession } from "../stores/session";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"];

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const login = useSession((state) => state.login);
  const navigate = useNavigate();

  async function submit() {
    if (!username.trim() || pin.length < 4) {
      setError("Ingrese usuario y PIN (4 dígitos).");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(username.trim().toLowerCase(), pin);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        setError("Demasiados intentos. Espere unos minutos.");
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Usuario o PIN incorrectos.");
      } else {
        setError("No se pudo iniciar sesión. Verifique su conexión.");
      }
      setPin("");
    } finally {
      setLoading(false);
    }
  }

  function press(key: string) {
    if (key === "⌫") setPin((value) => value.slice(0, -1));
    else if (key === "OK") void submit();
    else if (pin.length < 10) setPin((value) => value + key);
  }

  return (
    <div className="login-page">
      <div className="logo">🍽️ Restaurante</div>
      <div className="subtitle">Gestión de pedidos en tiempo real</div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label className="label" htmlFor="username">
            Usuario
          </label>
          <input
            id="username"
            className="input"
            value={username}
            autoCapitalize="none"
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
            placeholder="mesero1"
          />
        </div>

        <div className="field">
          <label className="label">PIN</label>
          <div className="pin-display">{pin ? "•".repeat(pin.length) : "—"}</div>
        </div>

        <div className="pin-pad" style={{ marginBottom: 16 }}>
          {KEYS.map((key) => (
            <button type="button" key={key} onClick={() => press(key)}>
              {key}
            </button>
          ))}
        </div>

        {error ? <div className="error-text" style={{ textAlign: "center", marginBottom: 10 }}>{error}</div> : null}

        <button className="btn block" type="submit" disabled={loading}>
          {loading ? "Ingresando…" : "Ingresar"}
        </button>
      </form>

      <div className="hint" style={{ textAlign: "center", marginTop: 18 }}>
        Admin <strong>admin/1234</strong> · Mesero <strong>mesero1/1234</strong> · Cocina{" "}
        <strong>cocina1/1234</strong> · Parrilla <strong>parrilla1/1234</strong>
      </div>
    </div>
  );
}
