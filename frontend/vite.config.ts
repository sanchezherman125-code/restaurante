import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const apiProxyTarget = loadEnv(mode, ".", "").VITE_API_PROXY_TARGET ?? "http://localhost:8000";

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.png", "icons/icon-192.png", "icons/icon-512.png"],
        manifest: {
          name: "Restaurante — Gestión de Pedidos",
          short_name: "Restaurante",
          description: "Pedidos, cocina, parrilla y cobros en tiempo real",
          theme_color: "#0c0d0f",
          background_color: "#0c0d0f",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          navigateFallback: "/index.html",
        },
        devOptions: { enabled: false },
      }),
    ],
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      globals: false,
      include: ["src/**/*.test.{ts,tsx}"],
    },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: apiProxyTarget, changeOrigin: true, ws: true },
        "/uploads": { target: apiProxyTarget, changeOrigin: true },
        "/health": { target: apiProxyTarget, changeOrigin: true },
      },
    },
    preview: { port: 4173 },
    build: { outDir: "dist", sourcemap: false },
  };
});
