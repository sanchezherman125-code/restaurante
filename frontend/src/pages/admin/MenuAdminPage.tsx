import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage } from "../../lib/send";
import { money } from "../../hooks/useElapsed";
import { useUi } from "../../stores/ui";
import type { MenuCategory, MenuItem, PreparationArea } from "../../types/api";

interface ItemForm {
  id?: string;
  category_id: string;
  name: string;
  description: string;
  price: string;
  requires_preparation: boolean;
  preparation_area: PreparationArea | null;
  expected_prep_minutes: string;
  is_active: boolean;
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
    setBusy(true);
    try {
      const payload = {
        category_id: itemForm.category_id,
        name: itemForm.name.trim(),
        description: itemForm.description.trim() || null,
        price: Number(itemForm.price).toFixed(2),
        requires_preparation: itemForm.requires_preparation,
        preparation_area: itemForm.requires_preparation ? itemForm.preparation_area : null,
        expected_prep_minutes: itemForm.requires_preparation && itemForm.expected_prep_minutes ? Number(itemForm.expected_prep_minutes) : null,
        is_active: itemForm.is_active,
      };
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
                preparation_area: "KITCHEN",
                expected_prep_minutes: "",
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
                      {money(item.price)} ·{" "}
                      {item.preparation_area === "GRILL" ? "parrilla" : item.preparation_area === "KITCHEN" ? "cocina" : "entrega directa"}
                      {item.expected_prep_minutes ? ` · ${item.expected_prep_minutes} min` : ""}
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
                        preparation_area: item.preparation_area,
                        expected_prep_minutes: item.expected_prep_minutes ? String(item.expected_prep_minutes) : "",
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
          <div className="grid-2">
            <div className="field">
              <label className="label">Precio (S/)</label>
              <input
                className="input"
                inputMode="decimal"
                value={itemForm.price}
                onChange={(event) => setItemForm({ ...itemForm, price: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="label">Tiempo (min)</label>
              <input
                className="input"
                inputMode="numeric"
                value={itemForm.expected_prep_minutes}
                onChange={(event) => setItemForm({ ...itemForm, expected_prep_minutes: event.target.value.replace(/\D/g, "") })}
                disabled={!itemForm.requires_preparation}
              />
            </div>
          </div>
          <div className="field">
            <label className="label">Área de preparación</label>
            <div className="segmented">
              {(["KITCHEN", "GRILL"] as PreparationArea[]).map((area) => (
                <button
                  key={area}
                  className={itemForm.requires_preparation && itemForm.preparation_area === area ? "active" : ""}
                  onClick={() => setItemForm({ ...itemForm, requires_preparation: true, preparation_area: area })}
                >
                  {area === "KITCHEN" ? "Cocina" : "Parrilla"}
                </button>
              ))}
              <button
                className={!itemForm.requires_preparation ? "active" : ""}
                onClick={() => setItemForm({ ...itemForm, requires_preparation: false, preparation_area: null, expected_prep_minutes: "" })}
              >
                Entrega directa
              </button>
            </div>
          </div>
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
