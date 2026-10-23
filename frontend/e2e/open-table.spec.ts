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
