import { expect, test, type Browser } from "@playwright/test";
import { clickAll, ensureShiftOpen, login } from "./helpers";

async function createContext(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

test("§73 flujo principal completo: turno → mesa → comanda → cocina/parrilla → entrega → cobro → reporte", async ({
  browser,
}) => {
  const admin = await createContext(browser);
  const waiter = await createContext(browser);
  const kitchen = await createContext(browser);
  const grill = await createContext(browser);
  try {
    // 1. ADMIN abre turno
    await login(admin.page, "admin");
    await ensureShiftOpen(admin.page);

    // 2. MESERO abre Mesa 4 con 3 personas
    await login(waiter.page, "mesero1");
    await waiter.page.goto("/mesas");
    await waiter.page.getByRole("button", { name: /Mesa 4/ }).click();
    await waiter.page.getByRole("button", { name: "+", exact: true }).click();
    await waiter.page.getByRole("button", { name: "Abrir mesa", exact: true }).click();
    await expect(waiter.page.getByRole("heading", { name: "Mesa 4", exact: true })).toBeVisible();
    await expect(waiter.page.getByRole("dialog")).toHaveCount(0);

    // 3. Agrega producto de cocina, de parrilla y una bebida
    await waiter.page
      .locator(".menu-item", { hasText: "Causa limeña" })
      .getByRole("button", { name: "+ Agregar" })
      .click();
    await waiter.page
      .locator(".menu-item", { hasText: "Anticuchos" })
      .getByRole("button", { name: "+ Agregar" })
      .click();
    await waiter.page.getByRole("button", { name: "Bebidas", exact: true }).click();
    await waiter.page
      .locator(".menu-item", { hasText: "Inca Kola 500ml" })
      .getByRole("button", { name: "+ Agregar" })
      .click();

    // 4. Envía la comanda
    await waiter.page.getByTestId("send-command").click();
    await expect(waiter.page.getByText("Comanda enviada")).toBeVisible();

    // 5. COCINA recibe solo su parte
    await login(kitchen.page, "cocina1");
    const kitchenCard = kitchen.page.locator('[data-testid="prep-card"][data-table="Mesa 4"]');
    await expect(kitchenCard).toBeVisible();
    await expect(kitchenCard).toContainText("Causa limeña");
    await expect(kitchenCard).not.toContainText("Anticuchos");
    await expect(kitchenCard).not.toContainText("Inca Kola");

    // 6. PARRILLA recibe solo su parte
    await login(grill.page, "parrilla1");
    const grillCard = grill.page.locator('[data-testid="prep-card"][data-table="Mesa 4"]');
    await expect(grillCard).toBeVisible();
    await expect(grillCard).toContainText("Anticuchos");
    await expect(grillCard).not.toContainText("Causa limeña");

    // 7. Ambos comienzan preparación y marcan READY
    await kitchenCard.getByRole("button", { name: /Empezar/ }).click();
    await kitchenCard.getByRole("button", { name: /Listo/ }).click();
    await grillCard.getByRole("button", { name: /Empezar/ }).click();
    await grillCard.getByRole("button", { name: /Listo/ }).click();

    // 8. MESERO recibe el aviso de pedido listo
    await expect(waiter.page.getByText(/Listo para entregar/)).toBeVisible({ timeout: 25_000 });

    // 9. MESERO marca la entrega de todos los productos
    await expect(waiter.page.getByRole("button", { name: /Entregado/ }).first()).toBeVisible({ timeout: 20_000 });
    await clickAll(waiter.page, /Entregado/);
    await expect(waiter.page.getByRole("button", { name: /Entregado/ })).toHaveCount(0);

    // 10. ADMIN divide la cuenta por monto
    await admin.page.goto("/pedidos");
    const orderCard = admin.page.locator(".ticket-card", { hasText: "Mesa 4" });
    await expect(orderCard).toBeVisible();
    await orderCard.getByRole("button", { name: /Cobro/ }).click();
    await expect(admin.page.getByRole("heading", { name: "Mesa 4", exact: true })).toBeVisible();
    await admin.page.getByLabel("Monto a dividir (S/)").fill("10");
    await admin.page.getByRole("button", { name: "Dividir", exact: true }).click();
    await expect(admin.page.getByText("División registrada")).toBeVisible();

    // 11. ADMIN registra el pago del saldo restante
    await admin.page.getByRole("button", { name: /^Cobrar S\// }).click();
    await expect(admin.page.getByText("Pedido pagado", { exact: true })).toBeVisible();

    // 12. ADMIN cierra el turno
    await admin.page.goto("/turnos");
    await admin.page.getByRole("button", { name: "Cerrar turno", exact: true }).first().click();
    const dialog = admin.page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Cerrar turno", exact: true }).click();
    await expect(admin.page.getByText("Turno cerrado")).toBeVisible();

    // 13. El reporte contiene la venta
    await admin.page.goto("/historial");
    await admin.page.getByRole("button", { name: "Ver reporte" }).first().click();
    const ventasKpi = admin.page.locator(".kpi", { hasText: "Ventas" }).first();
    await expect(ventasKpi).toBeVisible();
    const ventas = Number((await ventasKpi.innerText()).replace(/[^0-9.]/g, ""));
    expect(ventas).toBeGreaterThanOrEqual(36);
  } finally {
    for (const client of [admin, waiter, kitchen, grill]) {
      await client.context.close();
    }
  }
});
