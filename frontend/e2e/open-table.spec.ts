import { expect, test } from "@playwright/test";
import { ensureShiftOpen, login } from "./helpers";

test("abrir una mesa y salir sin pedir no crea pedido ni ocupa la mesa", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);

  const waiter = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(waiter, "mesero1");
  await waiter.goto("/mesas");
  await waiter.getByRole("button", { name: /Mesa 9/ }).click();
  await waiter.getByRole("button", { name: "Abrir mesa", exact: true }).click();
  await expect(waiter.getByRole("heading", { name: "Mesa 9", exact: true })).toBeVisible();
  await expect(waiter.getByText(/el pedido se crea al enviar la primera comanda/)).toBeVisible();

  const api = await browser.newContext({ baseURL });
  const token = (await (await api.request.post("/api/v1/auth/login", { data: { username: "admin", pin: "1234" } })).json()).access_token;
  const auth = { Authorization: `Bearer ${token}` };
  const activeFor = async () => (await (await api.request.get("/api/v1/orders/active", { headers: auth })).json())
    .filter((order: { table_name: string }) => order.table_name === "Mesa 9");
  const tableStatus = async () => (await (await api.request.get("/api/v1/tables", { headers: auth })).json())
    .find((table: { name: string }) => table.name === "Mesa 9").status;

  expect(await activeFor()).toHaveLength(0);
  expect(await tableStatus()).toBe("FREE");

  // Salir sin pedir: la mesa sigue libre para todos.
  await waiter.getByRole("button", { name: "Cerrar mesa" }).click();
  await expect(waiter.getByRole("button", { name: /Mesa 9, libre/ })).toBeVisible();
  expect(await activeFor()).toHaveLength(0);

  // Al enviar la primera comanda nace el pedido, con su comanda.
  await waiter.getByRole("button", { name: /Mesa 9/ }).click();
  await waiter.getByRole("button", { name: "Abrir mesa", exact: true }).click();
  await waiter.getByRole("button", { name: "Bebidas", exact: true }).click();
  await waiter.locator(".menu-item", { hasText: "Inca Kola 500ml" }).getByRole("button", { name: "Agregar Inca Kola 500ml", exact: true }).click();
  await waiter.getByRole("button", { name: /Ver comanda/ }).click();
  await waiter.getByTestId("send-command").click();
  await waiter.getByRole("button", { name: "Confirmar envío", exact: true }).click();
  await expect(waiter.getByText("Comanda enviada")).toBeVisible();
  await expect.poll(async () => (await activeFor()).length).toBe(1);
  const [order] = await activeFor();
  expect(order.items).toHaveLength(1);
  expect(await tableStatus()).toBe("OPEN");
  await api.close();
});

async function openDraftAndPrepare(page: import("@playwright/test").Page, table: string) {
  await page.goto("/mesas");
  await page.getByRole("button", { name: new RegExp(table) }).click();
  await page.getByRole("button", { name: "Abrir mesa", exact: true }).click();
  await expect(page.getByRole("heading", { name: table, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bebidas", exact: true }).click();
  await page.locator(".menu-item", { hasText: "Inca Kola 500ml" }).getByRole("button", { name: "Agregar Inca Kola 500ml", exact: true }).click();
  await page.getByRole("button", { name: /Ver comanda/ }).click();
}

test("dos dispositivos envían a la vez la primera comanda de la misma mesa: un pedido, el otro recibe un conflicto y conserva su carrito", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);
  const a = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const b = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(a, "mesero1");
  await login(b, "mesero1");
  await openDraftAndPrepare(a, "Mesa 5");
  await openDraftAndPrepare(b, "Mesa 5");
  // Ambos confirman a la vez.
  for (const page of [a, b]) await page.getByTestId("send-command").click();
  await Promise.all([a, b].map((page) => page.getByRole("button", { name: "Confirmar envío", exact: true }).click()));

  await expect.poll(async () => {
    const results = await Promise.all([a, b].map(async (page) => ({
      ok: await page.getByText("Comanda enviada").isVisible(),
      conflict: await page.getByText("Esta mesa ya fue abierta por otro mesero").isVisible(),
    })));
    return `${results.filter((r) => r.ok).length}-${results.filter((r) => r.conflict).length}`;
  }, { timeout: 20_000 }).toBe("1-1");

  const loser = (await a.getByText("Esta mesa ya fue abierta por otro mesero").isVisible()) ? a : b;
  await expect(loser.getByTestId("send-command")).toBeVisible(); // el carrito sigue ahí
  await expect(loser.getByText(/1 unidad/).first()).toBeVisible();

  const api = await browser.newContext({ baseURL });
  const token = (await (await api.request.post("/api/v1/auth/login", { data: { username: "admin", pin: "1234" } })).json()).access_token;
  const orders = (await (await api.request.get("/api/v1/orders/active", { headers: { Authorization: `Bearer ${token}` } })).json())
    .filter((order: { table_name: string }) => order.table_name === "Mesa 5");
  expect(orders).toHaveLength(1);
  expect(orders[0].commands).toHaveLength(1);
  await api.close();
});

test("sin conexión la primera comanda queda en cola y, al reconectar, se crea un único pedido con su comanda", async ({ browser, baseURL }) => {
  const admin = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, "mesero1");
  await openDraftAndPrepare(page, "Mesa 10");
  await context.setOffline(true);
  await page.getByTestId("send-command").click();
  await page.getByRole("button", { name: "Confirmar envío", exact: true }).click();
  await expect(page.getByTestId("sync-indicator")).toContainText("por enviar");

  const api = await browser.newContext({ baseURL });
  const token = (await (await api.request.post("/api/v1/auth/login", { data: { username: "admin", pin: "1234" } })).json()).access_token;
  const mesa10 = async () => (await (await api.request.get("/api/v1/orders/active", { headers: { Authorization: `Bearer ${token}` } })).json())
    .filter((order: { table_name: string }) => order.table_name === "Mesa 10");
  expect(await mesa10()).toHaveLength(0); // nada llegó al servidor: tampoco un pedido vacío

  await context.setOffline(false);
  await expect(page.getByTestId("sync-indicator")).toContainText("sincronizado", { timeout: 30_000 });
  await expect.poll(async () => (await mesa10()).length).toBe(1);
  const [order] = await mesa10();
  expect(order.commands).toHaveLength(1);
  expect(order.items).toHaveLength(1);
  await api.close();
});
