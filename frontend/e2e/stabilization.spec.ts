import { expect, test, type APIRequestContext, type Browser, type Page } from "./fixtures";
import { ensureShiftOpen, login } from "./helpers";

// Mesas 2 y 3 no las usa ningún otro E2E: estas pruebas no dependen del orden de ejecución.

async function apiAs(browser: Browser, baseURL: string | undefined, username: string) {
  const context = await browser.newContext({ baseURL });
  const response = await context.request.post("/api/v1/auth/login", { data: { username, pin: "1234" } });
  const headers = { Authorization: `Bearer ${(await response.json()).access_token}` };
  return { request: context.request, headers, close: () => context.close() };
}

async function activeOrdersOf(request: APIRequestContext, headers: Record<string, string>, table: string) {
  const orders = await (await request.get("/api/v1/orders/active", { headers })).json();
  return orders.filter((order: { table_name: string }) => order.table_name === table);
}

/** Tarjeta de indicador por su etiqueta exacta (las notas de otras tarjetas pueden repetir la palabra). */
const kpi = (page: Page, label: string) => page.locator(".kpi").filter({ has: page.locator(".label", { hasText: new RegExp(`^${label}$`) }) });

const money = (amount: number) => (amount < 0 ? `-S/ ${(-amount).toFixed(2)}` : `S/ ${amount.toFixed(2)}`);

async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

test("P0-01/P0-02: sin conexión la PWA recarga, la mesa pendiente sigue accesible y sincroniza una sola vez", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);

  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, "mesero1");
  await page.goto("/mesas");
  await waitForServiceWorker(page);

  await page.getByRole("button", { name: /Mesa 2,/ }).click();
  await page.getByRole("button", { name: "Abrir mesa", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mesa 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bebidas", exact: true }).click();
  await page.locator(".menu-item", { hasText: "Inca Kola 500ml" })
    .getByRole("button", { name: "Agregar Inca Kola 500ml", exact: true }).click();
  await page.getByRole("button", { name: /Ver comanda/ }).click();

  await context.setOffline(true);
  await page.getByTestId("send-command").click();
  await page.getByRole("button", { name: "Confirmar envío", exact: true }).click();
  await expect(page.getByTestId("sync-indicator")).toContainText("por enviar");

  // Salir de la mesa y volver a entrar: antes la mesa quedaba deshabilitada.
  await page.getByRole("button", { name: "Salón" }).click();
  const tile = page.getByRole("button", { name: /Mesa 2, .*sincronización pendiente/ });
  await expect(tile).toBeEnabled();
  await tile.click();
  await expect(page.getByTestId("local-command-line")).toContainText("Inca Kola 500ml");

  // Recargar sin conexión: la sesión y los datos locales autorizados siguen disponibles.
  await page.reload();
  await expect(page).toHaveURL(/\/mesas\//);
  await expect(page.getByRole("heading", { name: "Mesa 2", exact: true })).toBeVisible();
  await expect(page.getByTestId("local-command-line")).toContainText("Inca Kola 500ml");
  await expect(page.getByTestId("sync-indicator")).toContainText("por enviar");
  await page.getByRole("button", { name: "Salón" }).click();
  await expect(page.getByRole("button", { name: /Mesa 2, .*sincronización pendiente/ })).toBeVisible();

  const api = await apiAs(browser, baseURL, "admin");
  expect(await activeOrdersOf(api.request, api.headers, "Mesa 2")).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByTestId("sync-indicator")).toContainText("sincronizado", { timeout: 30_000 });
  await expect.poll(async () => (await activeOrdersOf(api.request, api.headers, "Mesa 2")).length).toBe(1);
  const [order] = await activeOrdersOf(api.request, api.headers, "Mesa 2");
  expect(order.commands).toHaveLength(1);
  expect(order.items).toHaveLength(1);
  await expect(page.getByRole("button", { name: /Mesa 2, ocupada/ })).toBeVisible({ timeout: 20_000 });

  // Otra recarga ya conectada no reenvía nada.
  await page.reload();
  await expect(page.getByRole("button", { name: /Mesa 2, ocupada/ })).toBeVisible();
  await page.waitForTimeout(2000);
  const [after] = await activeOrdersOf(api.request, api.headers, "Mesa 2");
  expect(after.commands).toHaveLength(1);
  await api.close();
});

test("P0-03: un gasto sin ventas nuevas se refleja en el panel y baja el resultado neto", async ({ browser, baseURL }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, "admin");
  await ensureShiftOpen(page);
  const api = await apiAs(browser, baseURL, "admin");
  const before = await (await api.request.get("/api/v1/reports/current-shift", { headers: api.headers })).json();

  await page.goto("/panel");
  await expect(kpi(page, "Gastos")).toContainText(money(Number(before.total_expenses)));

  await page.goto("/gastos");
  await page.getByLabel("Monto (S/)").fill("80");
  await page.getByLabel("Descripción").fill("Carbón E2E");
  await page.getByRole("button", { name: "Registrar gasto" }).click();
  await expect(page.getByText("Gasto registrado")).toBeVisible();

  const expectedExpenses = Number(before.total_expenses) + 80;
  const expectedNet = Number(before.total_sales) - expectedExpenses;
  await page.goto("/panel");
  await expect(kpi(page, "Gastos")).toContainText(money(expectedExpenses));
  await expect(kpi(page, "Resultado neto")).toContainText(money(expectedNet));

  const after = await (await api.request.get("/api/v1/reports/current-shift", { headers: api.headers })).json();
  expect(Number(after.total_expenses)).toBeCloseTo(expectedExpenses, 2);
  expect(Number(after.net_result)).toBeCloseTo(expectedNet, 2);
  await api.close();
});

test("P0-04: Todo muestra el historial completo y Turno actual vuelve al turno abierto", async ({ browser, baseURL }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, "admin");
  await ensureShiftOpen(page);
  const api = await apiAs(browser, baseURL, "admin");
  const all = await (await api.request.get("/api/v1/reports/sales?scope=all", { headers: api.headers })).json();
  const current = await (await api.request.get("/api/v1/reports/sales", { headers: api.headers })).json();

  await page.goto("/reportes");
  await page.getByRole("button", { name: "Todo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Todo", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Historial completo")).toBeVisible();
  await expect(kpi(page, "Ventas")).toContainText(money(Number(all.total_sales)));
  await expect(kpi(page, "Gastos")).toContainText(money(Number(all.total_expenses)));
  await expect(kpi(page, "Resultado neto")).toContainText(money(Number(all.net_result)));

  await page.getByRole("button", { name: "Turno actual", exact: true }).click();
  await expect(kpi(page, "Gastos")).toContainText(money(Number(current.total_expenses)));
  await api.close();
});

test("P0-05: una mesa ocupada no se puede desactivar y su pedido no cambia", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);

  const waiter = await (await browser.newContext()).newPage();
  await login(waiter, "mesero1");
  await waiter.goto("/mesas");
  await waiter.getByRole("button", { name: /Mesa 3,/ }).click();
  await waiter.getByRole("button", { name: "Abrir mesa", exact: true }).click();
  await waiter.getByRole("button", { name: "Bebidas", exact: true }).click();
  await waiter.locator(".menu-item", { hasText: "Agua mineral 620ml" })
    .getByRole("button", { name: "Agregar Agua mineral 620ml", exact: true }).click();
  await waiter.getByRole("button", { name: /Ver comanda/ }).click();
  await waiter.getByTestId("send-command").click();
  await waiter.getByRole("button", { name: "Confirmar envío", exact: true }).click();
  await expect(waiter.getByText("Comanda enviada")).toBeVisible();

  await admin.goto("/admin/mesas");
  await admin.getByRole("button", { name: /Editar Mesa 3, ocupada/ }).click();
  await expect(admin.getByRole("dialog").getByRole("button", { name: "Inactiva", exact: true })).toBeDisabled();

  const api = await apiAs(browser, baseURL, "admin");
  const [before] = await activeOrdersOf(api.request, api.headers, "Mesa 3");
  const table = (await (await api.request.get("/api/v1/tables", { headers: api.headers })).json())
    .find((entry: { number: number }) => entry.number === 3);
  const response = await api.request.patch(`/api/v1/tables/${table.id}`, { headers: api.headers, data: { is_active: false } });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe("TABLE_OCCUPIED");
  const [after] = await activeOrdersOf(api.request, api.headers, "Mesa 3");
  expect(after).toMatchObject({ id: before.id, status: before.status, total: before.total });
  await api.close();
});

test("Codex 1: la copia local sobrevive a una API caída (con red) y a una recarga sin conexión", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);
  await admin.context().close();

  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, "mesero1");
  await page.goto("/mesas");
  await waitForServiceWorker(page);
  await expect(page.getByRole("button", { name: /^Mesa 1,/ })).toBeVisible();
  const userId = await page.evaluate(() => JSON.parse(localStorage.getItem("restaurante.session") ?? "{}").state?.user?.id as string);
  const cacheKey = `restaurante.queryCache.${userId}`;
  const cachedTables = () => page.evaluate((key) => (localStorage.getItem(key) ?? "").includes("Mesa 1"), cacheKey);
  await expect.poll(cachedTables).toBe(true);

  // 1-3. La API deja de responder pero el navegador sigue "en línea": recarga y reintentos fallidos.
  await context.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.reload();
  await expect(page.getByRole("button", { name: /^Mesa 1,/ })).toBeVisible();
  await page.waitForTimeout(5000); // reintento de React Query (1) + refresco de la cola
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  expect(await cachedTables()).toBe(true);

  // 4-5. Desconexión total y nueva recarga: la sesión y los datos locales siguen disponibles.
  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveURL(/\/mesas$/);
  await expect(page.getByRole("button", { name: /^Mesa 1,/ })).toBeVisible();
  expect(await cachedTables()).toBe(true);

  // Al reconectar se revalida con el servidor.
  await context.unroute("**/api/**");
  const revalidated = page.waitForResponse((response) => response.url().includes("/api/v1/tables") && response.status() === 200);
  await context.setOffline(false);
  await revalidated;
  await expect(page.getByRole("button", { name: /^Mesa 1,/ })).toBeVisible();
  await context.close();
});

test("Codex 2b: una cola de la versión anterior (sin turno) queda en revisión y no registra nada", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);

  const api = await apiAs(browser, baseURL, "admin");
  const tables = await (await api.request.get("/api/v1/tables", { headers: api.headers })).json();
  const free = tables.find((table: { status: string; is_active: boolean }) => table.status === "FREE" && table.is_active);
  const menu = await (await api.request.get("/api/v1/menu", { headers: api.headers })).json();
  const drink = menu.items.find((item: { name: string }) => item.name === "Inca Kola 500ml");
  const expensesBefore = (await (await api.request.get("/api/v1/expenses", { headers: api.headers })).json()).length;

  const page = await (await browser.newContext()).newPage();
  await login(page, "mesero1");
  await page.goto("/mesas");
  const userId = await page.evaluate(() => JSON.parse(localStorage.getItem("restaurante.session") ?? "{}").state?.user?.id as string);

  // Cola tal como la dejaba 4321dd2 (sin shift_id), con su referencia de mesa pendiente.
  await page.evaluate(async ({ owner, tableId, tableName, menuItemId }) => {
    const base = { owner_user_id: owner, method: "POST", parent_operation_id: null, attempt_count: 1,
      last_attempt_at: Date.now(), status: "LOCAL_PENDING", last_error: null };
    const ops = [
      { ...base, client_operation_id: crypto.randomUUID(), operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses",
        body: { amount: "80.00", description: "Gasto legado E2E", receipt_url: null }, created_at: Date.now() },
      { ...base, client_operation_id: crypto.randomUUID(), operation_type: "OPEN_TABLE_WITH_COMMAND", path: "/api/v1/orders/open-with-command",
        body: { table_id: tableId, persons_count: 2, items: [{ menu_item_id: menuItemId, quantity: 1, notes: null }], notes: null, order_notes: null },
        created_at: Date.now() + 1 },
    ];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("restaurante-offline", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("queue", "readwrite");
      for (const op of ops) tx.objectStore("queue").put(op);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem(`restaurante.pendingOrders.${owner}`, JSON.stringify([{ operation_id: ops[1].client_operation_id,
      table_id: tableId, table_name: tableName, persons_count: 2, created_at: Date.now(), server_order_id: null, error: null }]));
  }, { owner: userId, tableId: free.id, tableName: free.name, menuItemId: drink.id });

  // "Actualizar el cliente": la versión nueva arranca con esa cola.
  await page.reload();
  const indicator = page.getByTestId("sync-indicator");
  await expect(indicator).toContainText("2 con error", { timeout: 30_000 });
  await indicator.click();
  await expect(page.getByRole("dialog")).toContainText("versión anterior");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: new RegExp(`^${free.name},.*error de sincronización`) })).toBeVisible();

  await page.waitForTimeout(3000); // otra ronda de sincronización no debe enviarlas
  const expenses = await (await api.request.get("/api/v1/expenses", { headers: api.headers })).json();
  expect(expenses).toHaveLength(expensesBefore);
  expect(expenses.some((expense: { description: string }) => expense.description === "Gasto legado E2E")).toBe(false);
  expect(await activeOrdersOf(api.request, api.headers, free.name)).toHaveLength(0);
  await api.close();
});

test("Codex 2a: el 401 de una operación de A tras cambiar a B no renueva ni registra nada a nombre de B", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);
  const adminApi = await apiAs(browser, baseURL, "admin");
  const adminTokens = await (await adminApi.request.post("/api/v1/auth/login", { data: { username: "admin", pin: "1234" } })).json();

  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, "mesero1");
  await page.goto("/gastos");
  await expect(page.getByRole("heading", { name: "Gastos del turno" })).toBeVisible();

  // Gasto de A guardado sin conexión.
  await context.setOffline(true);
  await page.getByLabel("Monto (S/)").fill("80");
  await page.getByLabel("Descripción").fill("Gasto 401 E2E");
  await page.getByRole("button", { name: "Registrar gasto" }).click();
  await expect(page.getByTestId("sync-indicator")).toContainText("por enviar");

  // Al reconectar, mientras viaja el envío de A, el dispositivo pasa a tener las credenciales de B
  // y la respuesta a A es 401 (sesión revocada).
  const refreshCalls: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/v1/auth/refresh")) refreshCalls.push(request.url()); });
  let intercepted = 0;
  await context.route("**/api/v1/expenses", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    intercepted += 1;
    await page.evaluate(({ access, refresh }) => {
      localStorage.setItem("restaurante.access", access);
      localStorage.setItem("restaurante.refresh", refresh);
    }, { access: adminTokens.access_token, refresh: adminTokens.refresh_token });
    await route.fulfill({ status: 401, contentType: "application/json",
      body: JSON.stringify({ error: { code: "INVALID_TOKEN", message: "Sesión expirada o revocada.", details: {} } }) });
  });
  await context.setOffline(false);
  await expect.poll(() => intercepted).toBe(1);
  await page.waitForTimeout(3000); // tiempo para cualquier renovación o reintento indebido

  expect(refreshCalls).toEqual([]);
  expect(intercepted).toBe(1);
  const expenses = await (await adminApi.request.get("/api/v1/expenses", { headers: adminApi.headers })).json();
  expect(expenses.some((expense: { description: string }) => expense.description === "Gasto 401 E2E")).toBe(false);
  // La operación sigue siendo de A, pendiente y con su UUID; las credenciales de B no se tocaron.
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("restaurante-offline", 1); r.onsuccess = () => resolve(r.result); });
    const ops = await new Promise<{ status: string; body: { description?: string } }[]>((resolve) => {
      const r = db.transaction("queue").objectStore("queue").getAll(); r.onsuccess = () => resolve(r.result);
    });
    return { ops: ops.map((op) => ({ status: op.status, description: op.body.description })), refresh: localStorage.getItem("restaurante.refresh") };
  });
  expect(stored.ops).toEqual([{ status: "LOCAL_PENDING", description: "Gasto 401 E2E" }]);
  expect(stored.refresh).toBe(adminTokens.refresh_token);
  const stillValid = await adminApi.request.post("/api/v1/auth/refresh", { data: { refresh_token: adminTokens.refresh_token } });
  expect(stillValid.status()).toBe(200);
  await adminApi.close();
});

test("Codex 3: el envío inmediato de A no renueva ni registra a nombre de B tras el 401", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);
  const adminApi = await apiAs(browser, baseURL, "admin");
  const adminTokens = await (await adminApi.request.post("/api/v1/auth/login", { data: { username: "admin", pin: "1234" } })).json();

  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, "mesero1");
  await page.goto("/gastos");
  await expect(page.getByRole("heading", { name: "Gastos del turno" })).toBeVisible();
  const waiterId = await page.evaluate(() => JSON.parse(localStorage.getItem("restaurante.session") ?? "{}").state?.user?.id as string);

  const refreshCalls: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/v1/auth/refresh")) refreshCalls.push(request.url()); });
  let intercepted = 0;
  await context.route("**/api/v1/expenses", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    intercepted += 1;
    // Mientras viaja el envío inmediato de A, el dispositivo pasa a tener las credenciales de B.
    await page.evaluate(({ access, refresh }) => {
      localStorage.setItem("restaurante.access", access);
      localStorage.setItem("restaurante.refresh", refresh);
    }, { access: adminTokens.access_token, refresh: adminTokens.refresh_token });
    await route.fulfill({ status: 401, contentType: "application/json",
      body: JSON.stringify({ error: { code: "INVALID_TOKEN", message: "Sesión expirada o revocada.", details: {} } }) });
  });

  // Con conexión: envío inmediato (sendOrQueue → expensesApi.create), sin pasar por la cola.
  await page.getByLabel("Monto (S/)").fill("0.01");
  await page.getByLabel("Descripción").fill("Gasto directo 401 E2E");
  await page.getByRole("button", { name: "Registrar gasto" }).click();
  await expect.poll(() => intercepted).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(3000); // tiempo para cualquier renovación o reintento indebido

  // Primero lo que importa: nada se registró a nombre de B.
  const expenses = await (await adminApi.request.get("/api/v1/expenses", { headers: adminApi.headers })).json();
  expect(expenses.some((expense: { description: string }) => expense.description === "Gasto directo 401 E2E")).toBe(false);
  expect(refreshCalls).toEqual([]);
  expect(intercepted).toBe(1);
  await expect(page.getByText("Sesión cambiada")).toBeVisible();
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("restaurante-offline", 1); r.onsuccess = () => resolve(r.result); });
    const ops = await new Promise<{ status: string; owner_user_id: string; client_operation_id: string; body: { description?: string } }[]>((resolve) => {
      const r = db.transaction("queue").objectStore("queue").getAll(); r.onsuccess = () => resolve(r.result);
    });
    return { ops, refresh: localStorage.getItem("restaurante.refresh") };
  });
  expect(stored.ops).toHaveLength(1);
  expect(stored.ops[0]).toMatchObject({ status: "LOCAL_PENDING", owner_user_id: waiterId, body: { description: "Gasto directo 401 E2E" } });
  expect(stored.refresh).toBe(adminTokens.refresh_token);
  expect((await adminApi.request.post("/api/v1/auth/refresh", { data: { refresh_token: adminTokens.refresh_token } })).status()).toBe(200);
  await adminApi.close();
});
