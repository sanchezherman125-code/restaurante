import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { purchaseApi } from "../api/endpoints";
import { EmptyState, Spinner } from "../components/Layout";
import { errorMessage } from "../lib/send";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";
import type { PreparationArea } from "../types/api";

const AREA_LABEL: Record<string, string> = { KITCHEN: "Cocina", GRILL: "Parrilla" };

export function PurchaseListPage() {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const role = useSession((state) => state.user?.role);
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [area, setArea] = useState<PreparationArea>(role === "GRILL" ? "GRILL" : "KITCHEN");
  const [saving, setSaving] = useState(false);

  const items = useQuery({ queryKey: ["purchase"], queryFn: purchaseApi.current, retry: false });

  async function submit() {
    if (!description.trim()) {
      toast("error", "Escriba qué se necesita comprar");
      return;
    }
    setSaving(true);
    try {
      await purchaseApi.create({
        area: role === "KITCHEN" ? "KITCHEN" : role === "GRILL" ? "GRILL" : area,
        description: description.trim(),
        quantity_text: quantity.trim() || null,
      });
      toast("success", "Agregado a la lista de compras");
      setDescription("");
      setQuantity("");
      void queryClient.invalidateQueries({ queryKey: ["purchase"] });
    } catch (error) {
      toast("error", "No se pudo agregar", errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await purchaseApi.remove(id);
      void queryClient.invalidateQueries({ queryKey: ["purchase"] });
    } catch (error) {
      toast("error", "No se pudo quitar", errorMessage(error));
    }
  }

  const grouped: Record<string, typeof items.data> = {};
  for (const item of items.data ?? []) {
    (grouped[item.area] ??= []).push(item);
  }

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Lista de compras</h2>
        <span className="hint">{items.data?.length ?? 0} ítems</span>
      </div>

      <div className="card">
        {role === "ADMIN" ? (
          <div className="field">
            <label className="label">Área</label>
            <div className="segmented">
              <button className={area === "KITCHEN" ? "active" : ""} onClick={() => setArea("KITCHEN")}>
                Cocina
              </button>
              <button className={area === "GRILL" ? "active" : ""} onClick={() => setArea("GRILL")}>
                Parrilla
              </button>
            </div>
          </div>
        ) : null}
        <div className="field">
          <label className="label">Producto / insumo</label>
          <input
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ej. carbón vegetal"
          />
        </div>
        <div className="field">
          <label className="label">Cantidad (opcional)</label>
          <input
            className="input"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="Ej. 2 sacos"
          />
        </div>
        <button className="btn block" onClick={() => void submit()} disabled={saving}>
          {saving ? "Agregando…" : "+ Agregar a la lista"}
        </button>
      </div>

      {items.isLoading ? (
        <Spinner />
      ) : (items.data ?? []).length === 0 ? (
        <EmptyState icon="🛒" title="La lista está vacía" hint="Lo que cocine o parrille necesita se agrega aquí." />
      ) : (
        Object.entries(grouped).map(([areaKey, list]) => (
          <div className="card" key={areaKey}>
            <div className="section-title" style={{ marginTop: 0 }}>
              <h2>{AREA_LABEL[areaKey] ?? areaKey}</h2>
            </div>
            {(list ?? []).map((item) => (
              <div className="item-row" key={item.id}>
                <div className="name">
                  <div style={{ fontWeight: 700 }}>{item.description}</div>
                  {item.quantity_text ? <div className="hint">{item.quantity_text}</div> : null}
                </div>
                <button className="btn ghost small" onClick={() => void remove(item.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
