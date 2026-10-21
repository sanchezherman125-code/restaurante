import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toasts } from "./components/Toasts";
import { startQueueSync } from "./stores/queue";
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

export default function App() {
  const restore = useSession((state) => state.restore);

  useEffect(() => {
    void restore();
    startQueueSync();
  }, [restore]);

  useEffect(() => useSession.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) queryClient.clear();
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
