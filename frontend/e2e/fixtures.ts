import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { APIRequestContext, Browser, Page } from "@playwright/test";

/**
 * Las pruebas abren varios dispositivos con ``browser.newContext()``; Playwright no los cierra solo
 * (el navegador vive durante todo el worker). Sin cerrarlos, cada página sigue consultando la API cada
 * 15 s y reconectando su WebSocket hasta el final de la suite, y la carga acumulada contamina las pruebas
 * siguientes. Este fixture automático cierra, al terminar cada prueba, los contextos que ella abrió.
 */
export const test = base.extend<{ closeOpenedContexts: void }>({
  closeOpenedContexts: [async ({ browser }, use) => {
    const before = new Set(browser.contexts());
    await use();
    await Promise.all(browser.contexts().filter((context) => !before.has(context)).map((context) => context.close()));
  }, { auto: true }],
});
