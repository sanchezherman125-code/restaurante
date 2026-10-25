import { expect, test, type APIRequestContext, type Browser } from "./fixtures";
import fs from "node:fs";
import path from "node:path";
import { login } from "./helpers";

/**
 * Herramienta de revisión visual: guarda capturas reales por rol y dispositivo en SHOTS_DIR.
 * No forma parte de la validación funcional (se omite si SHOTS_DIR no está definido).
 */
const SHOTS_DIR = process.env.SHOTS_DIR;
const VIEWPORTS = (process.env.SHOTS_VIEWPORTS ?? "desktop:1440x900,mobile:390x844")
  .split(",").map((entry) => {
    const [name, size] = entry.split(":");
    const [width, height] = size.split("x").map(Number);
    return { name, width, height };
  });

const ROUTES: Record<string, string[]> = {
  ADMIN: ["/panel", "/mesas", "/pedidos", "/comandas", "/carta", "/admin/mesas", "/usuarios", "/turnos", "/reportes",
    "/historial", "/gastos", "/compras", "/mas"],
  WAITER: ["/mesas", "/pedidos", "/gastos"],
  KITCHEN: ["/comandas", "/gastos", "/compras"],
  GRILL: ["/comandas"],
};
const USERNAME: Record<string, string> = { ADMIN: "admin", WAITER: "mesero1", KITCHEN: "cocina1", GRILL: "parrilla1" };

async function token(request: APIRequestContext, username: string): Promise<Record<string, string>> {
  const response = await request.post("/api/v1/auth/login", { data: { username, pin: "1234" } });
  return { Authorization: `Bearer ${(await response.json()).access_token}` };
}

async function seed(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const api = context.request;
  const admin = await token(api, "admin");
  const waiter = await token(api, "mesero1");
  const kitchen = await token(api, "cocina1");
  const grill = await token(api, "parrilla1");
  await api.post("/api/v1/shifts/open", { headers: admin });
  const menu = await (await api.get("/api/v1/menu", { headers: admin })).json();
  let wings = menu.items.find((item: { name: string }) => item.name === "Alitas con papas");
  if (!wings) {
    wings = await (await api.post("/api/v1/menu/items", { headers: admin, data: {
      category_id: menu.categories[0].id, name: "Alitas con papas", price: "25.00", requires_preparation: true,
      preparation_steps: [
        { name: "Preparar alitas", area: "GRILL", expected_minutes: 12 },
        { name: "Preparar papas", area: "KITCHEN", expected_minutes: 7 }],
    } })).json();
  }
  const byName = (name: string) => menu.items.find((item: { name: string }) => item.name === name);
  const tables = await (await api.get("/api/v1/tables", { headers: waiter })).json();
  const ids: string[] = [];
  const order = async (number: number, lines: [{ id: string }, number][], persons = 2) => {
    const table = tables.find((entry: { number: number }) => entry.number === number);
    const created = await (await api.post("/api/v1/orders", { headers: waiter, data: {
      order_type: "DINE_IN", table_id: table.id, persons_count: persons } })).json();
    const command = await (await api.post(`/api/v1/orders/${created.id}/commands`, { headers: waiter, data: {
      items: lines.map(([item, quantity]) => ({ menu_item_id: item.id, quantity })) } })).json();
    ids.push(created.id);
    return { order: created, items: command.items as { id: string; menu_item_name_snapshot: string; tasks: { id: string; area: string }[] }[] };
  };
  const task = (header: Record<string, string>, orderId: string, itemId: string, taskId: string, status: string) =>
    api.post(`/api/v1/orders/${orderId}/items/${itemId}/tasks/${taskId}/status`, { headers: header, data: { status } });

  const a = await order(1, [[wings, 2], [byName("Pollo a la brasa"), 1], [byName("Inca Kola 500ml"), 3]], 4);
  const wingsItem = a.items.find((item) => item.menu_item_name_snapshot === "Alitas con papas")!;
  const kitchenTask = wingsItem.tasks.find((t) => t.area === "KITCHEN")!;
  await task(kitchen, a.order.id, wingsItem.id, kitchenTask.id, "PREPARING");
  await task(kitchen, a.order.id, wingsItem.id, kitchenTask.id, "READY");
  const b = await order(2, [[byName("Parrilla especial"), 1], [byName("Anticuchos"), 2]], 3);
  const grillItem = b.items.find((item) => item.menu_item_name_snapshot === "Parrilla especial")!;
  await task(grill, b.order.id, grillItem.id, grillItem.tasks[0].id, "PREPARING");
  const c = await order(3, [[byName("Ensalada mixta"), 2], [byName("Causa limeña"), 1]], 2);
  void c;
  const d = await order(4, [[byName("Pollo a la brasa"), 2]], 2);
  await api.post(`/api/v1/orders/${d.order.id}/payments`, { headers: waiter, data: { method: "YAPE", amount: "20.00" } });
  await api.post("/api/v1/expenses", { headers: waiter, data: { amount: "35.50", description: "Carbón y limones" } });
  await api.post("/api/v1/purchase-list", { headers: kitchen, data: { area: "KITCHEN", description: "Papa amarilla", quantity_text: "2 sacos" } });
  await context.close();
  return ids;
}

test("capturas por rol y dispositivo", async ({ browser, baseURL }) => {
  test.skip(!SHOTS_DIR, "Defina SHOTS_DIR para generar capturas.");
  test.setTimeout(600_000);
  const dir = SHOTS_DIR!;
  fs.mkdirSync(dir, { recursive: true });
  const orderIds = await seed(browser, baseURL!);
  for (const viewport of VIEWPORTS) {
    for (const [role, routes] of Object.entries(ROUTES)) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      await login(page, USERNAME[role]);
      const targets = [...routes];
      if (role === "ADMIN" || role === "WAITER") targets.push(`/cobro/${orderIds[0]}`);
      for (const route of targets) {
        await page.goto(route);
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(dir, `${viewport.name}-${role}-${route.replace(/\W+/g, "_")}.png`), fullPage: false });
      }
      if (role === "WAITER" || role === "ADMIN") {
        await page.goto("/mesas");
        await page.waitForTimeout(500);
        await page.getByRole("button", { name: /Mesa 1/ }).first().click();
        await page.waitForTimeout(900);
        await page.screenshot({ path: path.join(dir, `${viewport.name}-${role}-detalle-mesa.png`) });
      }
      expect(true).toBe(true);
      await context.close();
    }
    const login_ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const loginPage = await login_ctx.newPage();
    await loginPage.goto("/login");
    await loginPage.waitForTimeout(400);
    await loginPage.screenshot({ path: path.join(dir, `${viewport.name}-login.png`) });
    await login_ctx.close();
  }
});
