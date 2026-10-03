import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { getAccessToken, getDeviceId } from "../api/client";
import { useSession } from "../stores/session";
import { playBeep, useUi } from "../stores/ui";

const EVENT_TOASTS: Record<string, { role?: string[]; kind: "success" | "info" | "warning"; title: (d: Record<string, unknown>) => string }> = {
  "order.ready": {
    role: ["WAITER", "ADMIN"],
    kind: "success",
    title: (d) => `${String(d["table_name"] ?? "Pedido")} — Listo para entregar`,
  },
  "order_item.ready": { kind: "info", title: () => "Producto listo" },
  "command.created": { role: ["KITCHEN", "GRILL", "ADMIN"], kind: "info", title: () => "Nueva comanda" },
  "order.created": { kind: "info", title: () => "Nuevo pedido" },
  "order.paid": { role: ["WAITER", "ADMIN"], kind: "success", title: () => "Pago registrado" },
  "availability.changed": {
    kind: "warning",
    title: (d) => `${String(d["name"] ?? "Producto")} — ${d["status"] === "SOLD_OUT" ? "agotado" : "disponible"}`,
  },
  "shift.opened": { kind: "info", title: () => "Turno abierto" },
  "shift.closed": { kind: "info", title: () => "Turno cerrado" },
};

function invalidateFor(event: string, client: QueryClient): void {
  switch (event) {
    case "order.created":
    case "order.updated":
    case "order.paid":
      void client.invalidateQueries({ queryKey: ["orders"] });
      void client.invalidateQueries({ queryKey: ["tables"] });
      break;
    case "command.created":
    case "order_item.updated":
    case "order_item.ready":
    case "order.ready":
      void client.invalidateQueries({ queryKey: ["preparation"] });
      void client.invalidateQueries({ queryKey: ["orders"] });
      void client.invalidateQueries({ queryKey: ["billing"] });
      break;
    case "tables.changed":
      void client.invalidateQueries({ queryKey: ["tables"] });
      void client.invalidateQueries({ queryKey: ["orders"] });
      break;
    case "menu.changed":
    case "availability.changed":
      void client.invalidateQueries({ queryKey: ["menu"] });
      break;
    case "purchase_list.changed":
      void client.invalidateQueries({ queryKey: ["purchase"] });
      break;
    case "shift.opened":
    case "shift.closed":
      void client.invalidateQueries({ queryKey: ["shifts"] });
      void client.invalidateQueries({ queryKey: ["reports"] });
      break;
    default:
      break;
  }
}

class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private client: QueryClient | null = null;
  private stopped = false;

  start(client: QueryClient): void {
    this.client = client;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  resync(): void {
    if (!this.client) return;
    void this.client.invalidateQueries();
  }

  private handle(event: string, data: Record<string, unknown>): void {
    if (!this.client) return;
    invalidateFor(event, this.client);

    const role = useSession.getState().user?.role;
    const config = EVENT_TOASTS[event];
    if (config && (!config.role || !role || config.role.includes(role))) {
      useUi.getState().toast(config.kind, config.title(data));
      if (event === "order.ready" || event === "command.created" || event === "availability.changed") {
        playBeep(event === "availability.changed" ? "error" : "ready");
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const token = getAccessToken();
    if (!token) return;

    const base = import.meta.env.VITE_API_URL || window.location.origin;
    const wsUrl = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const url = `${wsUrl}/api/v1/ws`;

    useUi.getState().setConnection("connecting");

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: "auth", token, device_id: getDeviceId() }));
      this.attempt = 0;
      useUi.getState().setConnection("online");
      this.resync();
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("ping");
      }, 25000);
    };

    this.ws.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data as string) as { event?: string; data?: Record<string, unknown> };
        if (parsed.event && parsed.event !== "pong") {
          this.handle(parsed.event, parsed.data ?? {});
        }
      } catch {
        // mensaje no parseable
      }
    };

    this.ws.onclose = () => {
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      if (this.stopped) return;
      useUi.getState().setConnection("offline");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.timer) window.clearTimeout(this.timer);
    const delay = Math.min(1000 * 2 ** this.attempt, 30000);
    this.attempt += 1;
    this.timer = window.setTimeout(() => this.connect(), delay);
  }
}

export const realtime = new RealtimeClient();

export function useRealtime(queryClient: QueryClient): void {
  useEffect(() => {
    const restart = () => {
      realtime.stop();
      realtime.start(queryClient);
    };
    if (useSession.getState().user) realtime.start(queryClient);
    const unsubscribe = useSession.subscribe((state, previous) => {
      if (state.user && !previous.user) restart();
      else if (!state.user && previous.user) realtime.stop();
    });
    return () => {
      unsubscribe();
      realtime.stop();
    };
  }, [queryClient]);
}
