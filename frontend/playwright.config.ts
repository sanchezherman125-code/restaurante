import { defineConfig } from "@playwright/test";

const appPort = Number(process.env.E2E_APP_PORT ?? 5174);
const apiPort = Number(process.env.E2E_API_PORT ?? 8010);
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql+psycopg://restaurante:restaurante@localhost:5433/restaurante_e2e_test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${appPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    viewport: { width: 390, height: 844 },
  },
  webServer: [
    {
      command: `VITE_API_PROXY_TARGET=http://localhost:${apiPort} npm run dev -- --port ${appPort}`,
      url: `http://localhost:${appPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `.venv/bin/uvicorn app.main:app --port ${apiPort}`,
      cwd: "../backend",
      url: `http://localhost:${apiPort}/health`,
      env: {
        ...process.env,
        DATABASE_ENV: "test",
        TEST_DATABASE_URL: testDatabaseUrl,
        CORS_ORIGINS: `http://localhost:${appPort}`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
