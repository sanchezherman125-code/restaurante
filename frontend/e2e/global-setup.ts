import { execFileSync } from "node:child_process";
import path from "node:path";

const defaultTestDatabaseUrl = "postgresql+psycopg://restaurante:restaurante@localhost:5433/restaurante_e2e_test";

function testDatabaseEnvironment(): NodeJS.ProcessEnv {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;
  const databaseName = new URL(testDatabaseUrl.replace("postgresql+psycopg://", "postgresql://")).pathname.slice(1).toLowerCase();
  if (process.env.DATABASE_ENV && process.env.DATABASE_ENV !== "test") {
    throw new Error("E2E abortado: DATABASE_ENV debe ser test.");
  }
  if (!databaseName.includes("test") && !databaseName.includes("e2e")) {
    throw new Error("E2E abortado: TEST_DATABASE_URL debe usar una base identificada como test/e2e.");
  }
  return { ...process.env, DATABASE_ENV: "test", TEST_DATABASE_URL: testDatabaseUrl };
}

/**
 * Los E2E parten de una base limpia: se truncan pedidos, turnos, pagos y gastos
 * conservando usuarios, carta y mesas del seed.
 */
export default function globalSetup(): void {
  const backend = path.resolve(process.cwd(), "../backend");
  const env = testDatabaseEnvironment();
  const python = path.join(backend, ".venv/bin/python");
  const options = {
    cwd: backend,
    stdio: "inherit",
    env,
  } as const;
  execFileSync(python, ["-m", "alembic", "upgrade", "head"], options);
  execFileSync(python, ["-m", "scripts.seed"], options);
  execFileSync(python, ["-m", "scripts.reset_db"], options);
}
