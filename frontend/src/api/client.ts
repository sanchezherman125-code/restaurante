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
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refresh = getRefreshToken();
      if (!refresh) return false;
      try {
        const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refresh }),
        });
        if (!response.ok) return false;
        const data = await response.json();
        setTokens(data.access_token, data.refresh_token);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => {
          refreshPromise = null;
        }, 0);
      }
    })();
  }
  return refreshPromise;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, idempotencyKey, auth = true, signal, formData } = options;

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
      signal,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new NetworkError();
  }

  if (response.status === 401 && auth) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiRequest<T>(path, { ...options, auth: true });
    }
    clearTokens();
    throw new ApiError(401, "SESSION_EXPIRED", "La sesión expiró. Inicie sesión nuevamente.");
  }

  if (response.status === 204) return undefined as T;

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
