import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { Icon } from "../components/Icon";
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
      <aside className="login-brand" aria-hidden="true">
        <span className="brand-mark"><Icon name="flame" /></span>
        <div className="login-statement">
          <strong>Restaurante</strong>
          <span>Salón, cocina, parrilla y caja en un mismo pase.</span>
        </div>
      </aside>

      <main className="login-panel">
        <div className="login-head">
          <span className="brand-mark small"><Icon name="flame" /></span>
          <h1>Ingresar</h1>
          <p className="hint">Use su usuario y su PIN.</p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label className="label" htmlFor="username">Usuario</label>
            <input
              id="username"
              className="input"
              value={username}
              autoCapitalize="none"
              autoComplete="username"
              autoFocus={typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="mesero1"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="pin">PIN</label>
            <input
              id="pin"
              className="input pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={10}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
              aria-describedby="pin-help"
              placeholder="••••"
            />
            <span id="pin-help" className="hint">4 a 10 dígitos. Puede escribirlo o usar el teclado numérico.</span>
          </div>

          <div className="pin-pad" role="group" aria-label="Teclado numérico">
            {KEYS.map((key) => (
              <button type="button" key={key} onClick={() => press(key)} aria-label={key === "⌫" ? "Borrar último dígito" : undefined}>
                {key}
              </button>
            ))}
          </div>

          {error ? <div className="error-text login-error" role="alert">{error}</div> : null}

          <button className="btn block large" type="submit" disabled={loading}>
            {loading ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </main>
    </div>
  );
}
