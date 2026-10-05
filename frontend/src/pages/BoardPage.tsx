import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi, preparationApi } from "../api/endpoints";
import { ConfirmDialog, Modal } from "../components/Modal";
import { EmptyState, Spinner } from "../components/Layout";
import { formatElapsed, useElapsed, useLateItems } from "../hooks/useElapsed";
import { errorMessage, sendOrQueue } from "../lib/send";
import type { ItemGroup, MenuItem, OrderItem } from "../types/api";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";

const AREA_LABEL: Record<string, string> = { KITCHEN: "Cocina", GRILL: "Parrilla" };

function ItemLine({
  item,
  groupId,
  updating,
  onStatus,
  onCancel,
}: {
  item: OrderItem;
  groupId: string;
  updating: boolean;
  onStatus: (item: OrderItem, status: string) => void;
  onCancel: (item: OrderItem) => void;
}) {
  const elapsed = useElapsed(item.preparation_started_at ?? item.created_at);
  const expected = (item.expected_prep_minutes_snapshot ?? 0) * 60;
  const late = expected > 0 && elapsed > expected && (item.status === "PENDING" || item.status === "PREPARING");
  const warn = expected > 0 && elapsed > expected * 0.8 && !late && item.status !== "DELIVERED";

  return (
    <div className="item-row" key={`${groupId}-${item.id}`}>
      <span className="qty">×{item.quantity}</span>
      <div className="name">
        <div style={{ fontWeight: 700 }}>{item.menu_item_name_snapshot}</div>
        {item.notes ? <div className="hint">📝 {item.notes}</div> : null}
        {item.replacement_description ? <div className="hint">🔁 {item.replacement_description}</div> : null}
        <div className="row wrap" style={{ marginTop: 6 }}>
          <span className={`timer ${late ? "late" : warn ? "warn" : ""}`}>{formatElapsed(elapsed)}</span>
          {expected > 0 ? <span className="hint">/ {item.expected_prep_minutes_snapshot} min</span> : null}
          <span className={`chip ${item.status === "PREPARING" ? "info" : item.status === "READY" ? "success" : "warning"}`}>
            {item.status === "PENDING" ? "pendiente" : item.status === "PREPARING" ? "preparando" : item.status === "READY" ? "listo" : item.status}
          </span>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {item.status === "PENDING" ? (
            <button className="btn small" disabled={updating} onClick={() => onStatus(item, "PREPARING")}>
              ▶ Empezar
            </button>
          ) : null}
          {item.status === "PREPARING" ? (
            <button className="btn success small" disabled={updating} onClick={() => onStatus(item, "READY")}>
              ✓ Listo
            </button>
          ) : null}
          {item.status === "PENDING" || item.status === "PREPARING" ? (
            <button className="btn ghost small" disabled={updating} onClick={() => onCancel(item)}>
              Cancelar
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Board({ area }: { area: string }) {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [cancelTarget, setCancelTarget] = useState<OrderItem | null>(null);
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  const [updatingItems, setUpdatingItems] = useState<Record<string, string>>({});

  const key = area === "GRILL" ? "grill" : "kitchen";
  const groups = useQuery({
    queryKey: ["preparation", key],
    queryFn: () => (area === "GRILL" ? preparationApi.grill() : preparationApi.kitchen()),
    refetchInterval: 15000,
    retry: false,
  });

  async function changeStatus(item: OrderItem, status: string) {
    if (updatingItems[item.id] && updatingItems[item.id] !== item.status) return;
    setUpdatingItems((current) => ({ ...current, [item.id]: status }));
    let queued = false;
    let completed = false;
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "UPDATE_ORDER_ITEM_STATUS",
          path: `/api/v1/orders/${item.order_id}/items/${item.id}/status`,
          method: "POST",
          body: { status },
        },
        (clientOperationId) => ordersApi.setItemStatus(item.order_id, item.id, status, clientOperationId),
      );
      queued = outcome.queued;
      completed = true;
      if (!queued) void queryClient.invalidateQueries({ queryKey: ["preparation"] });
    } catch (error) {
      toast("error", "No se pudo actualizar", errorMessage(error));
    } finally {
      if (!queued && !completed) {
        setUpdatingItems((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
      }
    }
  }

  async function cancelItem(item: OrderItem) {
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "CANCEL_ORDER_ITEM",
          path: `/api/v1/orders/${item.order_id}/items/${item.id}/cancel`,
          method: "POST",
          body: { reason: `Cancelado en ${AREA_LABEL[area]}` },
        },
        () => ordersApi.cancelItem(item.order_id, item.id, `Cancelado en ${AREA_LABEL[area]}`),
      );
      if (!outcome.queued) void queryClient.invalidateQueries({ queryKey: ["preparation"] });
      toast("info", "Producto cancelado");
    } catch (error) {
      toast("error", "No se pudo cancelar", errorMessage(error));
    } finally {
      setCancelTarget(null);
    }
  }

  if (groups.isLoading) return <Spinner label={`Cargando ${AREA_LABEL[area].toLowerCase()}…`} />;

  const data = groups.data ?? [];

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>{AREA_LABEL[area]} · comandas</h2>
        <div className="row">
          <button className="btn ghost small" onClick={() => setSoldOutOpen(true)}>
            🚫 Agotados
          </button>
          <button className="btn secondary small" onClick={() => void groups.refetch()}>
            ↻
          </button>
        </div>
      </div>

      {data.length === 0 ? (
        <EmptyState icon="✅" title="No hay comandas pendientes" hint="Las nuevas comandas aparecerán solas." />
      ) : (
        <div className="grid-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {data.map((group: ItemGroup) => (
            <GroupCard
              key={group.command_id}
              group={group}
              onStatus={(item, status) => void changeStatus(item, status)}
              onCancel={(item) => setCancelTarget(item)}
              updatingItems={updatingItems}
            />
          ))}
        </div>
      )}

      {cancelTarget ? (
        <ConfirmDialog
          title="Cancelar producto"
          message={`¿Cancelar ${cancelTarget.quantity} × ${cancelTarget.menu_item_name_snapshot}? Quedará registrado en auditoría (se notifica al mesero).`}
          confirmLabel="Cancelar"
          danger
          onConfirm={() => void cancelItem(cancelTarget)}
          onCancel={() => setCancelTarget(null)}
        />
      ) : null}

      {soldOutOpen ? <SoldOutModal area={area} onClose={() => setSoldOutOpen(false)} /> : null}
    </div>
  );
}

function GroupCard({
  group,
  onStatus,
  onCancel,
  updatingItems,
}: {
  group: ItemGroup;
  onStatus: (item: OrderItem, status: string) => void;
  onCancel: (item: OrderItem) => void;
  updatingItems: Record<string, string>;
}) {
  const elapsed = useElapsed(group.created_at);
  const latenessInput = useMemo(
    () =>
      group.items.map((item) => ({
        id: item.id,
        expectedMinutes: item.expected_prep_minutes_snapshot,
        startedAt: item.preparation_started_at,
        createdAt: item.created_at,
        status: item.status,
      })),
    [group.items],
  );
  const lateIds = useLateItems(latenessInput);
  const anyLate = lateIds.size > 0;
  const allReady = group.items.every(
    (item) => item.status === "READY" || item.status === "DELIVERED" || item.status === "CANCELLED",
  );

  return (
    <div className="ticket-card" data-testid="prep-card" data-table={group.table_name ?? ""} style={{ margin: 0 }}>
      <div className="ticket-head">
        <strong>{group.table_name ?? (group.order_type === "TAKEAWAY" ? "Para llevar" : "Pedido")}</strong>
        <span className="chip">#{group.sequence_number}</span>
        <span className="grow" />
        <span className={`timer ${anyLate ? "late" : ""}`}>{formatElapsed(elapsed)}</span>
      </div>
      <div className="ticket-body">
        <div className="row wrap" style={{ margin: "6px 0" }}>
          {group.persons_count ? <span className="chip">{group.persons_count} pers.</span> : null}
          <span className={`chip ${allReady ? "success" : "info"}`}>{allReady ? "lista" : "en curso"}</span>
          {Object.entries(group.other_areas ?? {}).map(([areaName, status]) => (
            <span key={areaName} className="chip">
              {AREA_LABEL[areaName] ?? areaName}: {status}
            </span>
          ))}
        </div>
        {group.notes ? <div className="hint">🗒️ {group.notes}</div> : null}
        {group.command_notes ? <div className="hint">📝 {group.command_notes}</div> : null}
        {group.items.map((item) => (
          <ItemLine
            key={item.id}
            item={item}
            groupId={group.command_id}
            updating={Boolean(updatingItems[item.id] && updatingItems[item.id] !== item.status)}
            onStatus={onStatus}
            onCancel={onCancel}
          />
        ))}
      </div>
    </div>
  );
}

function SoldOutModal({ area, onClose }: { area: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [saving, setSaving] = useState(false);
  const menu = useQuery({ queryKey: ["menu"], queryFn: menuApi.get });

  async function toggle(item: MenuItem) {
    setSaving(true);
    try {
      const next = item.availability_status === "SOLD_OUT" ? "AVAILABLE" : "SOLD_OUT";
      await menuApi.setAvailability(item.id, next);
      void queryClient.invalidateQueries({ queryKey: ["menu"] });
      toast("info", `${item.name}: ${next === "SOLD_OUT" ? "agotado" : "disponible"}`);
    } catch (error) {
      toast("error", "No se pudo actualizar", errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const items = (menu.data?.items ?? []).filter((item) => item.preparation_area === area && item.is_active);

  return (
    <Modal title="Marcar productos agotados" onClose={onClose}>
      <p className="hint">Al marcar un producto como agotado, los meseros verán la carta actualizada en tiempo real.</p>
      <div className="stack" style={{ marginTop: 10 }}>
        {items.map((item) => (
          <div className="row" key={item.id}>
            <span className="grow">{item.name}</span>
            <button
              className={`btn small ${item.availability_status === "SOLD_OUT" ? "warning" : "secondary"}`}
              disabled={saving}
              onClick={() => void toggle(item)}
            >
              {item.availability_status === "SOLD_OUT" ? "Agotado 🚫" : "Disponible ✓"}
            </button>
          </div>
        ))}
        {items.length === 0 ? <div className="hint">Este área no tiene productos cargados.</div> : null}
      </div>
    </Modal>
  );
}

export function BoardPage() {
  const role = useSession((state) => state.user?.role);
  const [adminArea, setAdminArea] = useState<"KITCHEN" | "GRILL">("KITCHEN");
  const area = role === "GRILL" ? "GRILL" : role === "KITCHEN" ? "KITCHEN" : adminArea;

  return (
    <div>
      {role === "ADMIN" ? (
        <div className="segmented" style={{ marginBottom: 14 }}>
          <button className={area === "KITCHEN" ? "active" : ""} onClick={() => setAdminArea("KITCHEN")}>
            👨‍🍳 Cocina
          </button>
          <button className={area === "GRILL" ? "active" : ""} onClick={() => setAdminArea("GRILL")}>
            🔥 Parrilla
          </button>
        </div>
      ) : null}
      <Board area={area} />
    </div>
  );
}
