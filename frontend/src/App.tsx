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

  useRealtime(queryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <Toasts />
      <AppRouter />
    </QueryClientProvider>
  );
}
