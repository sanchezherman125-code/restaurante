import type { ApiErrorBody } from "../types/api";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

const ACCESS_KEY = "restaurante.access";
const REFRESH_KEY = "restaurante.refresh";
const DEVICE_KEY = "restaurante.device";

export class ApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Las credenciales guardadas ya no son del usuario al que pertenece la petición: no se envía en su nombre. */
export class OwnerChangedError extends Error {
  constructor(message = "La sesión cambió de usuario durante el envío.") {
    super(message);
    this.name = "OwnerChangedError";
  }
}

export class NetworkError extends Error {
  constructor(message = "Sin conexión con el servidor.") {
    super(message);
    this.name = "NetworkError";
  }
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function getDeviceId(): string {
  let device = localStorage.getItem(DEVICE_KEY);
  if (!device) {
    device = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, device);
  }
  return device;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  idempotencyKey?: string;
  auth?: boolean;
  signal?: AbortSignal;
  formData?: FormData;
  responseType?: "blob";
  /** Usuario en cuyo nombre viaja la petición: ni ella, ni su renovación, ni su reintento usan credenciales
   * de otro usuario. Por defecto, el dueño del token guardado al iniciar la petición. */
  owner?: string;
}

/** Resultado de renovar la sesión: solo "invalid" significa que las credenciales ya no sirven.
 * "superseded": mientras se renovaba, otra sesión reemplazó los tokens; no se tocan. */
export type RefreshOutcome = "refreshed" | "invalid" | "unreachable" | "superseded";

let refreshPromise: Promise<RefreshOutcome> | null = null;

export async function refreshSession(): Promise<RefreshOutcome> {
  if (!refreshPromise) {
    refreshPromise = (async (): Promise<RefreshOutcome> => {
      const refresh = getRefreshToken();
      try {
        if (!refresh) return "invalid";
        const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ refresh_token: refresh }),
        });
        // Un servidor caído o saturado no invalida la sesión: se reintenta al recuperar la conexión.
        if (response.status >= 500 || response.status === 408 || response.status === 429) return "unreachable";
        // Otro usuario ingresó mientras tanto: sus tokens no se reemplazan ni se invalidan.
        if (getRefreshToken() !== refresh) return "superseded";
        if (!response.ok) return "invalid";
        const data = await response.json();
        if (getRefreshToken() !== refresh) return "superseded";
        setTokens(data.access_token, data.refresh_token);
        return "refreshed";
      } catch {
        return "unreachable";
      } finally {
        setTimeout(() => {
          refreshPromise = null;
        }, 0);
      }
    })();
  }
  return refreshPromise;
}

export async function tryRefresh(): Promise<boolean> {
  return (await refreshSession()) === "refreshed";
}

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/** Avisa cuando el servidor rechazó definitivamente las credenciales (no por falta de conexión). */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

function expireSession(): void {
  clearTokens();
  for (const listener of sessionExpiredListeners) listener();
}

/** Fallo transitorio (red, servidor caído): nunca justifica cerrar la sesión ni descartar operaciones. */
export function isConnectivityError(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
}

/** Usuario dueño del token guardado. Solo identifica la sesión local; el servidor sigue validando la firma. */
export function storedTokenSubject(): string | null {
  const token = getAccessToken() ?? getRefreshToken();
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

function ensureOwner(owner: string | undefined): void {
  if (owner !== undefined && storedTokenSubject() !== owner) throw new OwnerChangedError();
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}, refreshedOnce = false): Promise<T> {
  const { method = "GET", body, idempotencyKey, auth = true, signal, formData } = options;
  // Toda petición autenticada queda ligada a quien la inició (envío inmediato o cola).
  const owner = options.owner ?? (auth ? storedTokenSubject() ?? undefined : undefined);
  ensureOwner(owner);

  const headers: Record<string, string> = { "X-Device-Id": getDeviceId() };
  if (!formData) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      signal: signal ?? AbortSignal.timeout(15000),
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new NetworkError();
  }

  if (response.status === 401 && auth) {
    // El 401 es de las credenciales con que salió la petición: si ya hay otro usuario, no se renueva
    // ni se reintenta con las suyas, y su sesión no se toca.
    ensureOwner(owner);
    const outcome: RefreshOutcome = refreshedOnce ? "invalid" : await refreshSession();
    if (outcome === "refreshed") {
      // El reintento vuelve a comprobar al dueño antes de salir (ensureOwner al inicio).
      return apiRequest<T>(path, { ...options, auth: true, owner }, true);
    }
    // Sin conexión para renovar: la sesión local se conserva y la operación queda pendiente.
    if (outcome === "unreachable") throw new NetworkError();
    if (outcome === "superseded") {
      if (owner !== undefined) throw new OwnerChangedError();
      throw new ApiError(401, "SESSION_EXPIRED", "La sesión cambió. Vuelva a intentarlo.");
    }
    expireSession();
    throw new ApiError(401, "SESSION_EXPIRED", "La sesión expiró. Inicie sesión nuevamente.");
  }

  if (response.status === 204) return undefined as T;
  if (response.ok && options.responseType === "blob") return await response.blob() as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = payload as ApiErrorBody | null;
    if (errorBody?.error) {
      throw new ApiError(response.status, errorBody.error.code, errorBody.error.message, errorBody.error.details);
    }
    throw new ApiError(response.status, "HTTP_ERROR", `Error ${response.status}`);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => apiRequest<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
};
