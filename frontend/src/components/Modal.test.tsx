import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";

function Form() {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(true);
  if (!open) return <div>cerrado</div>;
  // onClose cambia de identidad en cada render, como en las pantallas reales.
  return (
    <Modal title="Formulario" onClose={() => setOpen(false)}>
      <input aria-label="campo" value={value} onChange={(event) => setValue(event.target.value)} />
    </Modal>
  );
}

describe("Modal", () => {
  it("no roba el foco del campo mientras se escribe aunque el padre se vuelva a renderizar", async () => {
    const user = userEvent.setup();
    render(<Form />);
    const input = screen.getByLabelText("campo");
    await user.type(input, "Preparar papas");
    expect(input).toHaveValue("Preparar papas");
    expect(document.activeElement).toBe(input);
  });

  it("Escape sigue cerrando el diálogo", async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.keyboard("{Escape}");
    expect(screen.getByText("cerrado")).toBeVisible();
  });
});
