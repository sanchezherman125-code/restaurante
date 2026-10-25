import { useEffect, useState } from "react";

function secondsSince(value: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
}

/** Devuelve los segundos transcurridos desde `since` y se actualiza cada segundo. */
export function useElapsed(since: string | null | undefined): number {
  const [seconds, setSeconds] = useState(() => (since ? secondsSince(since) : 0));

  useEffect(() => {
    if (!since) return;
    let cancelled = false;
    const update = () => {
      if (!cancelled) setSeconds(secondsSince(since));
    };
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [since]);

  return since ? seconds : 0;
}

/** Reloj compartido para ordenar por urgencia sin llamar a Date.now() durante el render. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function money(value: string | number | null | undefined): string {
  const amount = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(amount)) return "S/ 0.00";
  // Un resultado neto negativo se lee "-S/ 80.00", con el signo delante de la moneda.
  return amount < 0 && amount.toFixed(2) !== "-0.00" ? `-S/ ${(-amount).toFixed(2)}` : `S/ ${Math.abs(amount).toFixed(2)}`;
}

export interface LatenessInput {
  id: string;
  expectedMinutes: number | null;
  startedAt: string | null;
  createdAt: string;
  status: string;
}

/** Marca como atrasados los productos que superaron su tiempo esperado. */
export function useLateItems(items: LatenessInput[]): Set<string> {
  const [late, setLate] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const compute = () => {
      if (cancelled) return;
      const next = new Set<string>();
      const now = Date.now();
      for (const item of items) {
        const expected = (item.expectedMinutes ?? 0) * 60;
        if (!expected) continue;
        const startedAt = new Date(item.startedAt ?? item.createdAt).getTime();
        const elapsed = (now - startedAt) / 1000;
        if (elapsed > expected && item.status !== "READY" && item.status !== "DELIVERED") next.add(item.id);
      }
      setLate(next);
    };
    const initial = window.setTimeout(compute, 0);
    const timer = window.setInterval(compute, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [items]);

  return late;
}
