import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ITEM_STATUS, ORDER_STATUS, TASK_STATUS } from "../lib/labels";
import { Modal } from "./Modal";
import { SearchField, SkeletonList, StatusBadge } from "./Layout";

function Search() {
  const [value, setValue] = useState("");
  return (<><input aria-label="otro campo" /><SearchField value={value} onChange={setValue} label="Buscar mesa" hotkey /></>);
}

describe("SearchField", () => {
  it('"/" enfoca la búsqueda desde cualquier parte sin escribir el carácter', async () => {
    const user = userEvent.setup();
    render(<Search />);
    await user.keyboard("/");
    expect(screen.getByLabelText("Buscar mesa")).toHaveFocus();
    expect(screen.getByLabelText("Buscar mesa")).toHaveValue("");
  });

  it('"/" se escribe con normalidad dentro de otro campo', async () => {
    const user = userEvent.setup();
    render(<Search />);
    await user.click(screen.getByLabelText("otro campo"));
    await user.keyboard("a/b");
    expect(screen.getByLabelText("otro campo")).toHaveValue("a/b");
    expect(screen.getByLabelText("otro campo")).toHaveFocus();
  });
});

describe("estados comunicados con texto, no solo con color", () => {
  it("StatusBadge siempre muestra el texto del estado", () => {
    render(<StatusBadge label="Listo para entregar" tone="ok" icon="check" />);
    expect(screen.getByText("Listo para entregar")).toBeVisible();
  });

  it("ningún estado interno se muestra como código en inglés", () => {
    const labels = [...Object.values(ORDER_STATUS), ...Object.values(ITEM_STATUS), ...Object.values(TASK_STATUS)].map((entry) => entry.label);
    for (const label of labels) expect(label).not.toMatch(/[A-Z]{3,}|_/);
    expect(ORDER_STATUS.IN_PREPARATION.label).toBe("En preparación");
    expect(ORDER_STATUS.CANCELLED.label).toBe("Cancelado");
  });

  it("SkeletonList expone un estado de carga accesible", () => {
    render(<SkeletonList label="Cargando mesas" />);
    expect(screen.getByRole("status", { name: "Cargando mesas" })).toBeInTheDocument();
  });
});

function WithModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      {open ? (
        <Modal title="Formulario" onClose={() => setOpen(false)}>
          <input aria-label="primero" autoFocus />
          <button>Guardar</button>
        </Modal>
      ) : null}
    </>
  );
}

describe("Modal accesible", () => {
  it("devuelve el foco al botón que lo abrió aunque un campo tenga autoFocus", async () => {
    const user = userEvent.setup();
    render(<WithModal />);
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    expect(screen.getByLabelText("primero")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Abrir" })).toHaveFocus();
  });

  it("Tab y Shift+Tab circulan dentro del diálogo", async () => {
    const user = userEvent.setup();
    render(<WithModal />);
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 8; i += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });
});
