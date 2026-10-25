import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toasts } from "./components/Toasts";
import { persistQueryCache, purgeQueryCaches, restoreQueryCache } from "./offline/queryCache";
import { queueCounts, startQueueSync, useQueue } from "./stores/queue";
import { useSession } from "./stores/session";
import { AppRouter } from "./router";
import { useRealtime } from "./websocket/useSocket";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

// Antes del primer render: al recargar sin conexión la interfaz parte de la última copia local del usuario.
const rememberedUser = useSession.getState().user;
purgeQueryCaches(rememberedUser?.id ?? null);
if (rememberedUser) restoreQueryCache(queryClient, rememberedUser.id);

export default function App() {
  const restore = useSession((state) => state.restore);

  useEffect(() => {
    void restore();
    startQueueSync();
  }, [restore]);

  useEffect(() => useSession.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) {
      queryClient.clear();
      purgeQueryCaches(state.user?.id ?? null);
    }
  }), []);

  useEffect(() => persistQueryCache(queryClient, () => useSession.getState().user?.id ?? null), []);

  useEffect(() => {
    // La identidad recuperada sin conexión se confirma con el servidor apenas vuelve la red.
    const onOnline = () => void useSession.getState().revalidate();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  useEffect(() => useQueue.subscribe((state, previous) => {
    // Una operación de la cola quedó confirmada: las pantallas pasan a mostrar el estado del servidor.
    if (queueCounts(state.operations).SYNCED > queueCounts(previous.operations).SYNCED) {
      for (const root of ["orders", "tables", "preparation", "expenses", "reports"]) {
        void queryClient.invalidateQueries({ queryKey: [root] });
      }
    }
  }), []);

  useEffect(() => {
    const onServiceWorkerMessage = (event: MessageEvent<{ type?: string; route?: string }>) => {
      if (event.data?.type !== "notification.navigate") return;
      const route = ["/comandas", "/pedidos", "/mesas"].includes(event.data.route ?? "") ? event.data.route! : "/";
      window.location.assign(route);
    };
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
  }, []);

  useRealtime(queryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <Toasts />
      <AppRouter />
    </QueryClientProvider>
  );
}
