import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { purchaseApi } from "../api/endpoints";
import { Icon } from "../components/Icon";
import { EmptyState, PageHeader, SkeletonList } from "../components/Layout";
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
    <div className="page">
      <PageHeader title="Lista de compras" subtitle={`${items.data?.length ?? 0} ${(items.data?.length ?? 0) === 1 ? "ítem pendiente" : "ítems pendientes"}`} />

      <div className="two-col expenses-layout">
        <form className="card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="section-title"><h2>Agregar a la lista</h2></div>
          {role === "ADMIN" ? (
            <div className="field">
              <span className="label" id="purchase-area">Área</span>
              <div className="segmented" role="group" aria-labelledby="purchase-area">
                <button type="button" className={area === "KITCHEN" ? "active" : ""} aria-pressed={area === "KITCHEN"} onClick={() => setArea("KITCHEN")}>Cocina</button>
                <button type="button" className={area === "GRILL" ? "active" : ""} aria-pressed={area === "GRILL"} onClick={() => setArea("GRILL")}>Parrilla</button>
              </div>
            </div>
          ) : null}
          <div className="field">
            <label className="label" htmlFor="purchase-desc">Producto o insumo</label>
            <input id="purchase-desc" className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ej. carbón vegetal" />
          </div>
          <div className="field">
            <label className="label" htmlFor="purchase-qty">Cantidad (opcional)</label>
            <input id="purchase-qty" className="input" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Ej. 2 sacos" />
          </div>
          <button className="btn block" type="submit" disabled={saving}><Icon name="plus" />{saving ? "Agregando…" : "Agregar a la lista"}</button>
        </form>

        <section aria-label="Lista actual" className="stack">
          {items.isLoading ? (
            <SkeletonList rows={3} height={56} label="Cargando lista" />
          ) : (items.data ?? []).length === 0 ? (
            <EmptyState icon="purchases" title="La lista está vacía" hint="Lo que cocina o parrilla necesita comprar se agrega aquí y lo ve todo el equipo." />
          ) : (
            Object.entries(grouped).map(([areaKey, list]) => (
              <div className="card" key={areaKey}>
                <div className="section-title"><h2>{AREA_LABEL[areaKey] ?? areaKey}</h2><span className="chip">{(list ?? []).length}</span></div>
                {(list ?? []).map((item) => (
                  <div className="item-row" key={item.id}>
                    <div className="name">
                      <div style={{ fontWeight: 650 }}>{item.description}</div>
                      {item.quantity_text ? <div className="hint">{item.quantity_text}</div> : null}
                    </div>
                    <button className="btn ghost small" aria-label={`Quitar ${item.description}`} onClick={() => void remove(item.id)}><Icon name="x" /></button>
                  </div>
                ))}
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
