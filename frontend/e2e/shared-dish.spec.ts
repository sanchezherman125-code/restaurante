import { expect, test, type Browser, type Page } from "@playwright/test";
import { ensureShiftOpen, login } from "./helpers";

async function createContext(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  return { context, page };
}

/** Crea «Alitas con papas» desde la pantalla de administración si la carta aún no lo tiene. */
async function ensureSharedDish(page: Page) {
  await page.goto("/carta");
  await expect(page.getByRole("heading", { name: "Carta", exact: true })).toBeVisible();
  if ((await page.getByText("Alitas con papas").count()) > 0) return;
  await page.getByRole("button", { name: "+ Producto", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").selectOption({ label: "Fondos" });
  await dialog.locator(".field", { hasText: "Nombre" }).first().locator("input").fill("Alitas con papas");
  await dialog.locator(".field", { hasText: "Precio (S/)" }).locator("input").fill("25");
  await dialog.getByLabel("Nombre de la tarea 1").fill("Preparar alitas");
  await dialog.getByRole("group", { name: "Área de la tarea 1" }).getByRole("button", { name: "Parrilla" }).click();
  await dialog.getByLabel("Tiempo de la tarea 1 (min)").fill("12");
  await dialog.getByRole("button", { name: "+ Agregar tarea" }).click();
  await dialog.getByLabel("Nombre de la tarea 2").fill("Preparar papas");
  await dialog.getByLabel("Tiempo de la tarea 2 (min)").fill("7");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText("Producto guardado")).toBeVisible();
  await expect(page.getByText("Preparar alitas (parrilla 12 min) + Preparar papas (cocina 7 min)")).toBeVisible();
}

async function openTableAndOrder(page: Page, table: string) {
  await page.goto("/mesas");
  await page.getByRole("button", { name: new RegExp(table) }).click();
  await page.getByRole("button", { name: "Abrir mesa", exact: true }).click();
  await expect(page.getByRole("heading", { name: table, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Fondos", exact: true }).click();
  await page
    .locator(".menu-item", { hasText: "Alitas con papas" })
    .getByRole("button", { name: "Agregar Alitas con papas", exact: true })
    .click();
  await page.getByRole("button", { name: /Ver comanda/ }).click();
  await page.getByTestId("send-command").click();
  await page.getByRole("button", { name: "Confirmar envío", exact: true }).click();
  await expect(page.getByText("Comanda enviada")).toBeVisible();
}

test("plato compartido: cocina y parrilla trabajan en paralelo y el mesero recibe un solo aviso de plato completo", async ({
  browser,
}) => {
  const admin = await createContext(browser);
  const waiter = await createContext(browser);
  const kitchen = await createContext(browser);
  const grill = await createContext(browser);
  try {
    await login(admin.page, "admin");
    await ensureShiftOpen(admin.page);
    await ensureSharedDish(admin.page);
    await login(waiter.page, "mesero1");
    await openTableAndOrder(waiter.page, "Mesa 7");

    // Cada área ve únicamente su tarea, con el estado de la otra.
    await login(kitchen.page, "cocina1");
    const kitchenCard = kitchen.page.locator('[data-testid="prep-card"][data-table="Mesa 7"]');
    await expect(kitchenCard).toBeVisible();
    await expect(kitchenCard).toContainText("Preparar papas");
    await expect(kitchenCard).not.toContainText("Preparar alitas");
    await expect(kitchenCard).toContainText("Parrilla: pendiente");

    await login(grill.page, "parrilla1");
    const grillCard = grill.page.locator('[data-testid="prep-card"][data-table="Mesa 7"]');
    await expect(grillCard).toBeVisible();
    await expect(grillCard).toContainText("Preparar alitas");
    await expect(grillCard).not.toContainText("Preparar papas");

    // Ambas empiezan a la vez; cocina termina primero.
    await kitchenCard.getByRole("button", { name: /Empezar/ }).click();
    await grillCard.getByRole("button", { name: /Empezar/ }).click();
    await kitchenCard.getByRole("button", { name: /Listo/ }).click();
    await expect(grillCard).toContainText("Cocina: listo", { timeout: 25_000 });
    await expect(kitchenCard).toContainText("Esperando a Parrilla");

    // Aún no hay plato completo para el mesero.
    await expect(waiter.page.getByText(/Plato listo/)).toHaveCount(0);
    await expect(waiter.page.getByRole("button", { name: /Entregado/ })).toHaveCount(0);

    // Parrilla termina: el plato queda listo una sola vez y puede entregarse.
    await grillCard.getByRole("button", { name: /Listo/ }).click();
    await expect(waiter.page.getByRole("button", { name: /Entregado/ })).toHaveCount(1, { timeout: 25_000 });
    // Un solo aviso visible: el pedido de un plato ya queda completo, así que avisa «Listo para entregar».
    await expect(waiter.page.getByText(/Listo para entregar/)).toHaveCount(1);
    await expect(waiter.page.getByText(/Plato listo/)).toHaveCount(0);
    await waiter.page.getByRole("button", { name: /Entregado/ }).click();
    await expect(waiter.page.getByRole("button", { name: /Entregado/ })).toHaveCount(0);

    // Un único cargo de S/ 25.00 en el cobro.
    await admin.page.goto("/pedidos");
    const orderCard = admin.page.locator(".ticket-card", { hasText: "Mesa 7" });
    await orderCard.getByRole("button", { name: /Cobro/ }).click();
    await expect(admin.page.getByText("Alitas con papas")).toHaveCount(1);
    await expect(admin.page.getByRole("button", { name: "Cobrar S/ 25.00" })).toBeVisible();
    await admin.page.getByRole("button", { name: "Plin", exact: true }).click();
    await admin.page.getByRole("button", { name: "Cobrar S/ 25.00" }).click();
    await expect(admin.page.getByText("Pedido pagado", { exact: true })).toBeVisible();
  } finally {
    for (const client of [admin, waiter, kitchen, grill]) await client.context.close();
  }
});

test("pago anticipado: el pedido cobrado sigue en cocina y parrilla hasta terminar la preparación", async ({
  browser,
}) => {
  const admin = await createContext(browser);
  const waiter = await createContext(browser);
  const kitchen = await createContext(browser);
  const grill = await createContext(browser);
  try {
    await login(admin.page, "admin");
    await ensureShiftOpen(admin.page);
    await ensureSharedDish(admin.page);
    await login(waiter.page, "mesero1");
    await openTableAndOrder(waiter.page, "Mesa 8");
    await login(kitchen.page, "cocina1");
    await login(grill.page, "parrilla1");

    await admin.page.goto("/pedidos");
    await admin.page.locator(".ticket-card", { hasText: "Mesa 8" }).getByRole("button", { name: /Cobro/ }).click();
    await admin.page.getByRole("button", { name: "Efectivo", exact: true }).click();
    await admin.page.getByRole("button", { name: "Cobrar S/ 25.00" }).click();
    await expect(admin.page.getByText("Pedido pagado", { exact: true })).toBeVisible();

    const kitchenCard = kitchen.page.locator('[data-testid="prep-card"][data-table="Mesa 8"]');
    const grillCard = grill.page.locator('[data-testid="prep-card"][data-table="Mesa 8"]');
    await kitchen.page.goto("/comandas");
    await grill.page.goto("/comandas");
    await expect(kitchenCard).toBeVisible();
    await expect(grillCard).toBeVisible();

    for (const card of [kitchenCard, grillCard]) {
      await card.getByRole("button", { name: /Empezar/ }).click();
      await card.getByRole("button", { name: /Listo/ }).click();
    }
    await expect(waiter.page.getByRole("button", { name: /Entregado/ })).toHaveCount(1, { timeout: 25_000 });
    await waiter.page.getByRole("button", { name: /Entregado/ }).click();
    await expect(kitchenCard).toHaveCount(0, { timeout: 25_000 });
    await expect(grillCard).toHaveCount(0, { timeout: 25_000 });
  } finally {
    for (const client of [admin, waiter, kitchen, grill]) await client.context.close();
  }
});
