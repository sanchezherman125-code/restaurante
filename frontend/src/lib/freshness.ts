/**
 * Lo que una pantalla puede afirmar sobre sus datos: confirmados por el servidor, la última copia conocida
 * (consulta fallida o en pausa sin conexión) o nada. Un fallo nunca se presenta como "no hay pedidos".
 */
export type Freshness = "loading" | "confirmed" | "stale" | "unavailable";

type QueryView = { data: unknown; isLoading: boolean; isError?: boolean; isPaused?: boolean };

export function freshness(query: QueryView): Freshness {
  if (query.data === undefined) return query.isLoading ? "loading" : "unavailable";
  return query.isError || query.isPaused ? "stale" : "confirmed";
}

/** Hora de la última copia; con fecha si no es de hoy. */
export function updatedAtLabel(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" })} ${time}`;
}
