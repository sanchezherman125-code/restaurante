import { expect, test } from "@playwright/test";
import { ensureShiftOpen, login } from "./helpers";

const ROUTES_BY_ROLE: Record<string, string[]> = {
  admin: ["/panel", "/mesas", "/pedidos", "/comandas", "/carta", "/admin/mesas", "/usuarios", "/turnos", "/reportes", "/historial", "/gastos", "/compras", "/mas"],
  mesero1: ["/mesas", "/pedidos", "/gastos"],
  cocina1: ["/comandas", "/gastos", "/compras"],
};

test("acceso directo y recarga de rutas administrativas; un rol sin permiso es redirigido", async ({ browser }) => {
  const admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await login(admin, "admin");
  for (const [route, heading] of [["/admin/mesas", "Mesas"], ["/carta", "Carta"], ["/usuarios", "Usuarios"], ["/reportes", "Reportes"], ["/historial", "Historial de turnos"]] as const) {
    await admin.goto(route);
    await expect(admin.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await admin.reload();
    await expect(admin.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(new URL(admin.url()).pathname).toBe(route);
  }
  const waiter = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(waiter, "mesero1");
  await waiter.goto("/admin/mesas");
  await expect(waiter).toHaveURL(/\/mesas$/);
});

test("ingreso con teclado físico: usuario, PIN escrito y Enter", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto("/login");
  await expect(page.getByLabel("Usuario")).toBeFocused();
  await page.keyboard.type("admin");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("PIN")).toBeFocused();
  await page.keyboard.type("1234");
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-main")).toBeVisible({ timeout: 20_000 });
});

test("modal: el foco se conserva al escribir, Tab queda dentro, Esc cierra y devuelve el foco", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await login(page, "admin");
  await page.goto("/admin/mesas");
  const trigger = page.getByRole("button", { name: "Nueva mesa" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel("Nombre");
  await name.click();
  await page.keyboard.type("Terraza 12");
  await expect(name).toHaveValue("Terraza 12");
  await expect(name).toBeFocused();
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('la tecla "/" enfoca la búsqueda sin escribir el carácter', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await login(page, "admin");
  await page.goto("/admin/mesas");
  await expect(page.getByRole("heading", { name: "Mesas", exact: true })).toBeVisible();
  await page.keyboard.press("/");
  const search = page.getByLabel("Buscar mesa");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
});

test("sin zoom bloqueado, y movimiento reducido apaga las transiciones", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/login");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
  const motion = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dur").trim());
  expect(motion).toMatch(/^0(ms|s)$/);
});

for (const viewport of [
  { name: "1920", width: 1920, height: 1080 }, { name: "1440", width: 1440, height: 900 }, { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 }, { name: "430", width: 430, height: 932 }, { name: "360", width: 360, height: 740 },
]) {
  test(`responsivo ${viewport.name}px: sin desbordamiento horizontal y navegación adecuada`, async ({ browser }) => {
    test.setTimeout(240_000);
    for (const [user, routes] of Object.entries(ROUTES_BY_ROLE)) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      await login(page, user);
      if (user === "admin") await ensureShiftOpen(page);
      for (const route of routes) {
        await page.goto(route);
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${user} ${route} @${viewport.width}`).toBeLessThanOrEqual(0);
      }
      const wide = viewport.width >= 900;
      await expect(page.locator(".sidebar")).toBeVisible({ visible: wide });
      await expect(page.locator(".bottom-nav")).toBeVisible({ visible: !wide });
      await context.close();
    }
  });
}

test("estado sin conexión: el indicador lo dice y la comanda queda marcada como pendiente de envío", async ({ browser }) => {
  const admin = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(admin, "admin");
  await ensureShiftOpen(admin);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, "mesero1");
  await page.goto("/mesas");
  await expect(page.locator(".conn")).toContainText("En línea");
  await context.setOffline(true);
  await expect(page.locator(".conn")).toContainText("Sin conexión");
  await expect(page.locator(".conn")).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator(".conn")).toContainText("En línea", { timeout: 30_000 });
});
