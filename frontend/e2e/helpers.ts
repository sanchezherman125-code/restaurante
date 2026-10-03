import { expect, type Page } from "@playwright/test";

export async function login(page: Page, username: string, pin = "1234"): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Usuario").fill(username);
  for (const key of pin.split("")) {
    await page.getByRole("button", { name: key, exact: true }).click();
  }
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(page.locator(".bottom-nav")).toBeVisible({ timeout: 20_000 });
}

export async function ensureShiftOpen(page: Page): Promise<void> {
  await page.goto("/turnos");
  await expect(page.getByRole("heading", { name: "Turnos", exact: true })).toBeVisible();
  const openButton = page.getByRole("button", { name: "Abrir turno", exact: true });
  if (await openButton.isVisible().catch(() => false)) {
    await openButton.click();
  }
  await expect(page.getByRole("heading", { name: "Turno abierto", exact: true })).toBeVisible();
}

export async function clickAll(page: Page, name: RegExp, max = 8): Promise<void> {
  const buttons = page.getByRole("button", { name });
  for (let i = 0; i < max; i += 1) {
    const count = await buttons.count();
    if (count === 0) return;
    await buttons.first().click();
    await page.waitForTimeout(300);
  }
}
