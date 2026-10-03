import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import { ensureShiftOpen, login } from "./helpers";

test("§74 comanda offline queda LOCAL_PENDING, sincroniza sin duplicar y respeta idempotencia", async ({
  browser,
  baseURL,
}) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const waiterContext = await browser.newContext();
  const waiterPage = await waiterContext.newPage();
  const kitchenContext = await browser.newContext();
  const kitchenPage = await kitchenContext.newPage();

  try {
    // Precondición: turno abierto
    await login(adminPage, "admin");
    await ensureShiftOpen(adminPage);

    // MESERO abre Mesa 6 con conexión
    await login(waiterPage, "mesero1");
    await waiterPage.goto("/mesas");
    await waiterPage.getByRole("button", { name: /Mesa 6/ }).click();
    await waiterPage.getByRole("button", { name: "Abrir mesa", exact: true }).click();
    await expect(waiterPage.getByRole("heading", { name: "Mesa 6", exact: true })).toBeVisible();
    await expect(waiterPage.getByRole("dialog")).toHaveCount(0);

    // Prepara la comanda y luego pierde conexión
    await waiterPage.getByRole("button", { name: "Entradas", exact: true }).click();
    await waiterPage
      .locator(".menu-item", { hasText: "Papa a la huancaína" })
      .getByRole("button", { name: "+ Agregar" })
      .click();

    await waiterContext.setOffline(true);
    await expect(waiterPage.locator(".conn")).toContainText("Sin conexión");

    await waiterPage.getByTestId("send-command").click();

    // Estado local: GUARDADO LOCALMENTE (nunca "recibido por cocina")
    const syncIndicator = waiterPage.getByTestId("sync-indicator");
    await expect(syncIndicator).toContainText("por enviar");
    await expect(waiterPage.getByText("Sin conexión", { exact: true }).first()).toBeVisible();

    // Cocina NO recibió nada todavía (el tablero ya terminó de cargar)
    await login(kitchenPage, "cocina1");
    await kitchenPage.goto("/comandas");
    await expect(kitchenPage.getByRole("heading", { name: /comandas/ })).toBeVisible();
    await expect(kitchenPage.locator('[data-testid="prep-card"][data-table="Mesa 6"]')).toHaveCount(0);

    // Recupera conexión: la cola reintenta
    await waiterContext.setOffline(false);
    await expect(syncIndicator).toContainText("sincronizado", { timeout: 30_000 });

    // Cocina recibe exactamente una comanda
    const kitchenCard = kitchenPage.locator('[data-testid="prep-card"][data-table="Mesa 6"]');
    await expect(kitchenCard).toBeVisible({ timeout: 25_000 });
    await expect(kitchenCard).toHaveCount(1);
    await expect(kitchenCard).toContainText("Papa a la huancaína");

    // Idempotencia: reenviar la misma operación no duplica la comanda
    const apiContext = await browser.newContext({ baseURL });
    const loginResponse = await apiContext.request.post("/api/v1/auth/login", {
      data: { username: "mesero1", pin: "1234" },
    });
    const { access_token } = await loginResponse.json();
    const auth = { Authorization: `Bearer ${access_token}` };

    const active = await (await apiContext.request.get("/api/v1/orders/active", { headers: auth })).json();
    const order = active.find((entry: { table_name: string }) => entry.table_name === "Mesa 6");
    expect(order).toBeTruthy();

    const menu = await (await apiContext.request.get("/api/v1/menu", { headers: auth })).json();
    const menuItem = menu.items.find((entry: { name: string }) => entry.name === "Papa a la huancaína");

    const idempotencyKey = crypto.randomUUID();
    const payload = { items: [{ menu_item_id: menuItem.id, quantity: 1 }] };
    const headers = { ...auth, "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" };

    const first = await apiContext.request.post(`/api/v1/orders/${order.id}/commands`, { headers, data: payload });
    const replay = await apiContext.request.post(`/api/v1/orders/${order.id}/commands`, { headers, data: payload });
    expect(first.status()).toBe(201);
    expect(replay.status()).toBe(201);
    expect(await first.json()).toMatchObject(await replay.json());

    const after = await (
      await apiContext.request.get(`/api/v1/orders/${order.id}`, { headers: auth })
    ).json();
    // 1 comanda enviada por la cola offline + 1 del par idempotente (el replay no crea otra)
    expect(after.commands).toHaveLength(2);
    expect(after.commands[0].items).toHaveLength(1);

    await apiContext.close();
  } finally {
    await adminContext.close();
    await waiterContext.close();
    await kitchenContext.close();
  }
});
