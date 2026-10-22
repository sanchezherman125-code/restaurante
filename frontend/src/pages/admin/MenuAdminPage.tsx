import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage } from "../../lib/send";
import { money } from "../../hooks/useElapsed";
import { useUi } from "../../stores/ui";
import type { MenuCategory, MenuItem, StepArea } from "../../types/api";

interface StepForm {
  key: string;
  id?: string;
  name: string;
  area: StepArea;
  minutes: string;
  is_active: boolean;
}

interface ItemForm {
  id?: string;
  category_id: string;
  name: string;
  description: string;
  price: string;
  requires_preparation: boolean;
  steps: StepForm[];
  is_active: boolean;
}

const AREA_LABEL: Record<StepArea, string> = { KITCHEN: "Cocina", GRILL: "Parrilla" };
const MAX_STEPS = 12;
const newKey = () => crypto.randomUUID();

function blankStep(): StepForm {
  return { key: newKey(), name: "", area: "KITCHEN", minutes: "", is_active: true };
}

function stepsFromItem(item: MenuItem): StepForm[] {
  if (item.preparation_steps?.length) {
    return item.preparation_steps.map((step) => ({
      key: step.id,
      id: step.id,
      name: step.name,
      area: step.area,
      minutes: step.expected_minutes != null ? String(step.expected_minutes) : "",
      is_active: step.is_active,
    }));
  }
  if (!item.requires_preparation || !item.preparation_area || item.preparation_area === "WAITER") return [];
  return [{ key: newKey(), name: item.name, area: item.preparation_area, minutes: item.expected_prep_minutes ? String(item.expected_prep_minutes) : "", is_active: true }];
}

export function describeSteps(item: MenuItem): string {
  if (!item.requires_preparation) return "entrega directa";
  const steps = (item.preparation_steps ?? []).filter((step) => step.is_active);
  if (steps.length === 0) {
    return `${item.preparation_area === "GRILL" ? "parrilla" : "cocina"}${item.expected_prep_minutes ? ` · ${item.expected_prep_minutes} min` : ""}`;
  }
  if (steps.length === 1) {
    return `${AREA_LABEL[steps[0].area].toLowerCase()}${steps[0].expected_minutes ? ` · ${steps[0].expected_minutes} min` : ""}`;
  }
  return steps
    .map((step) => `${step.name} (${AREA_LABEL[step.area].toLowerCase()}${step.expected_minutes ? ` ${step.expected_minutes} min` : ""})`)
    .join(" + ");
}

/** Devuelve el mensaje de error de validación, o null cuando las tareas son válidas. */
export function validateSteps(productName: string, steps: StepForm[]): string | null {
  if (steps.length === 0) return "Agregue al menos una tarea de preparación.";
  if (steps.length > MAX_STEPS) return `Máximo ${MAX_STEPS} tareas por producto.`;
  if (!steps.some((step) => step.is_active)) return "Debe haber al menos una tarea activa.";
  for (const step of steps) {
    if (!step.name.trim() && !(steps.length === 1 && productName.trim())) return "Cada tarea necesita un nombre.";
    if (step.minutes !== "" && Number(step.minutes) > 600) return "El tiempo de una tarea no puede superar 600 minutos.";
  }
  return null;
}

export function MenuAdminPage() {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const menu = useQuery({ queryKey: ["menu"], queryFn: menuApi.get, retry: false });

  async function saveItem() {
    if (!itemForm) return;
    if (!itemForm.name.trim() || Number(itemForm.price) <= 0) {
      toast("error", "Complete nombre y precio");
      return;
    }
    if (itemForm.requires_preparation) {
      const problem = validateSteps(itemForm.name, itemForm.steps);
      if (problem) {
        toast("error", "Revise la preparación", problem);
        return;
      }
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        category_id: itemForm.category_id,
        name: itemForm.name.trim(),
        description: itemForm.description.trim() || null,
        price: Number(itemForm.price).toFixed(2),
        requires_preparation: itemForm.requires_preparation,
        is_active: itemForm.is_active,
      };
      if (itemForm.requires_preparation) {
        payload.preparation_steps = itemForm.steps.map((step) => ({
          ...(step.id ? { id: step.id } : {}),
          name: step.name.trim() || itemForm.name.trim(),
          area: step.area,
          expected_minutes: step.minutes === "" ? null : Number(step.minutes),
          is_active: step.is_active,
        }));
      } else {
        payload.preparation_area = null;
        payload.expected_prep_minutes = null;
      }
      if (itemForm.id) await menuApi.updateItem(itemForm.id, payload);
      else await menuApi.createItem(payload);
      toast("success", "Producto guardado");
      setItemForm(null);
      void queryClient.invalidateQueries({ queryKey: ["menu"] });
    } catch (error) {
      toast("error", "No se pudo guardar", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function updateStep(key: string, patch: Partial<StepForm>) {
    setItemForm((form) => (form ? { ...form, steps: form.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)) } : form));
  }

  function moveStep(key: string, direction: -1 | 1) {
    setItemForm((form) => {
      if (!form) return form;
      const index = form.steps.findIndex((step) => step.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= form.steps.length) return form;
      const steps = [...form.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...form, steps };
    });
  }

  async function saveCategory() {
    if (!categoryName.trim()) return;
    setBusy(true);
    try {
      await menuApi.createCategory({ name: categoryName.trim(), sort_order: (menu.data?.categories.length ?? 0) + 1 });
      setCategoryName("");
      setCategoryOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["menu"] });
    } catch (error) {
      toast("error", "No se pudo crear la categoría", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCategory(category: MenuCategory) {
    try {
      await menuApi.updateCategory(category.id, { is_active: !category.is_active });
      void queryClient.invalidateQueries({ queryKey: ["menu"] });
    } catch (error) {
      toast("error", "No se pudo actualizar", errorMessage(error));
    }
  }

  async function toggleAvailability(item: MenuItem) {
    try {
      await menuApi.setAvailability(item.id, item.availability_status === "SOLD_OUT" ? "AVAILABLE" : "SOLD_OUT");
      void queryClient.invalidateQueries({ queryKey: ["menu"] });
    } catch (error) {
      toast("error", "No se pudo actualizar", errorMessage(error));
    }
  }

  if (menu.isLoading) return <Spinner label="Cargando carta…" />;

  const categories = menu.data?.categories ?? [];
  const items = menu.data?.items ?? [];

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Carta</h2>
        <div className="row">
          <button className="btn ghost small" onClick={() => setCategoryOpen(true)}>
            + Categoría
          </button>
          <button
            className="btn small"
            onClick={() =>
              setItemForm({
                category_id: categories[0]?.id ?? "",
                name: "",
                description: "",
                price: "",
                requires_preparation: true,
                steps: [blankStep()],
                is_active: true,
              })
            }
            disabled={categories.length === 0}
          >
            + Producto
          </button>
        </div>
      </div>

      {categories.length === 0 ? (
        <EmptyState icon="🍽️" title="Sin categorías" hint="Cree una categoría para empezar." />
      ) : (
        categories.map((category) => (
          <div className="card" key={category.id}>
            <div className="row wrap">
              <strong className="grow">{category.name}</strong>
              <span className={`chip ${category.is_active ? "open" : "danger"}`}>
                {category.is_active ? "visible" : "oculta"}
              </span>
              <button className="btn ghost small" onClick={() => void toggleCategory(category)}>
                {category.is_active ? "Ocultar" : "Mostrar"}
              </button>
            </div>

            {items
              .filter((item) => item.category_id === category.id)
              .map((item) => (
                <div className="item-row" key={item.id}>
                  <div className="name">
                    <div style={{ fontWeight: 700 }}>{item.name}</div>
                    <div className="hint">
                      {money(item.price)} · {describeSteps(item)}
                    </div>
                  </div>
                  <button
                    className={`btn small ${item.availability_status === "SOLD_OUT" ? "warning" : "secondary"}`}
                    onClick={() => void toggleAvailability(item)}
                  >
                    {item.availability_status === "SOLD_OUT" ? "Agotado" : "Disponible"}
                  </button>
                  <button
                    className="btn small secondary"
                    onClick={() =>
                      setItemForm({
                        id: item.id,
                        category_id: item.category_id,
                        name: item.name,
                        description: item.description ?? "",
                        price: String(item.price),
                        requires_preparation: item.requires_preparation,
                        steps: stepsFromItem(item),
                        is_active: item.is_active,
                      })
                    }
                  >
                    Editar
                  </button>
                </div>
              ))}
          </div>
        ))
      )}

      {categoryOpen ? (
        <Modal
          title="Nueva categoría"
          onClose={() => setCategoryOpen(false)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setCategoryOpen(false)}>
                Cancelar
              </button>
              <button className="btn grow" onClick={() => void saveCategory()} disabled={busy}>
                Crear
              </button>
            </>
          }
        >
          <input
            className="input"
            value={categoryName}
            onChange={(event) => setCategoryName(event.target.value)}
            placeholder="Ej. Entradas"
          />
        </Modal>
      ) : null}

      {itemForm ? (
        <Modal
          title={itemForm.id ? "Editar producto" : "Nuevo producto"}
          onClose={() => setItemForm(null)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setItemForm(null)}>
                Cancelar
              </button>
              <button className="btn grow" onClick={() => void saveItem()} disabled={busy}>
                {busy ? "Guardando…" : "Guardar"}
              </button>
            </>
          }
        >
          <div className="field">
            <label className="label">Categoría</label>
            <select
              className="select"
              value={itemForm.category_id}
              onChange={(event) => setItemForm({ ...itemForm, category_id: event.target.value })}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">Nombre</label>
            <input
              className="input"
              value={itemForm.name}
              onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="label">Descripción</label>
            <textarea
              className="textarea"
              value={itemForm.description}
              onChange={(event) => setItemForm({ ...itemForm, description: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="label">Precio (S/)</label>
            <input
              className="input"
              inputMode="decimal"
              value={itemForm.price}
              onChange={(event) => setItemForm({ ...itemForm, price: event.target.value })}
            />
            <div className="hint">Precio único del plato, sin importar en cuántas áreas se prepare.</div>
          </div>
          <div className="field">
            <label className="label">Entrega</label>
            <div className="segmented">
              <button
                className={itemForm.requires_preparation ? "active" : ""}
                onClick={() =>
                  setItemForm({
                    ...itemForm,
                    requires_preparation: true,
                    steps: itemForm.steps.length ? itemForm.steps : [blankStep()],
                  })
                }
              >
                Con preparación
              </button>
              <button
                className={!itemForm.requires_preparation ? "active" : ""}
                onClick={() => setItemForm({ ...itemForm, requires_preparation: false })}
              >
                Entrega directa
              </button>
            </div>
          </div>
          {itemForm.requires_preparation ? (
            <div className="field" data-testid="prep-steps">
              <label className="label">Preparación del producto</label>
              <div className="hint">Las tareas se preparan en paralelo. El plato queda listo cuando todas terminan.</div>
              <div className="stack" style={{ marginTop: 8 }}>
                {itemForm.steps.map((step, index) => (
                  <div className="card" key={step.key} data-testid="prep-step" style={{ padding: 12 }}>
                    <input
                      className="input"
                      aria-label={`Nombre de la tarea ${index + 1}`}
                      placeholder={itemForm.steps.length === 1 ? itemForm.name || "Nombre de la tarea" : "Ej. Preparar alitas"}
                      value={step.name}
                      onChange={(event) => updateStep(step.key, { name: event.target.value })}
                    />
                    <div className="segmented" style={{ marginTop: 8 }} role="group" aria-label={`Área de la tarea ${index + 1}`}>
                      {(["KITCHEN", "GRILL"] as StepArea[]).map((area) => (
                        <button
                          key={area}
                          className={step.area === area ? "active" : ""}
                          aria-pressed={step.area === area}
                          onClick={() => updateStep(step.key, { area })}
                        >
                          {AREA_LABEL[area]}
                        </button>
                      ))}
                    </div>
                    <div className="row wrap" style={{ marginTop: 8 }}>
                      <input
                        className="input"
                        style={{ width: 110 }}
                        inputMode="numeric"
                        aria-label={`Tiempo de la tarea ${index + 1} (min)`}
                        placeholder="min"
                        value={step.minutes}
                        onChange={(event) => updateStep(step.key, { minutes: event.target.value.replace(/\D/g, "").slice(0, 3) })}
                      />
                      <span className="hint grow">min</span>
                      <button className="btn ghost small" aria-label={`Subir tarea ${index + 1}`} disabled={index === 0} onClick={() => moveStep(step.key, -1)}>↑</button>
                      <button className="btn ghost small" aria-label={`Bajar tarea ${index + 1}`} disabled={index === itemForm.steps.length - 1} onClick={() => moveStep(step.key, 1)}>↓</button>
                      <button
                        className={`btn small ${step.is_active ? "secondary" : "warning"}`}
                        aria-pressed={step.is_active}
                        onClick={() => updateStep(step.key, { is_active: !step.is_active })}
                      >
                        {step.is_active ? "Activa" : "Inactiva"}
                      </button>
                      <button
                        className="btn ghost small"
                        aria-label={`Eliminar tarea ${index + 1}`}
                        onClick={() => setItemForm({ ...itemForm, steps: itemForm.steps.filter((entry) => entry.key !== step.key) })}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="btn secondary small"
                  disabled={itemForm.steps.length >= MAX_STEPS}
                  onClick={() => setItemForm({ ...itemForm, steps: [...itemForm.steps, blankStep()] })}
                >
                  + Agregar tarea
                </button>
              </div>
            </div>
          ) : null}
          <div className="field">
            <label className="label">Estado</label>
            <div className="segmented">
              <button className={itemForm.is_active ? "active" : ""} onClick={() => setItemForm({ ...itemForm, is_active: true })}>
                Activo
              </button>
              <button className={!itemForm.is_active ? "active" : ""} onClick={() => setItemForm({ ...itemForm, is_active: false })}>
                Inactivo
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
