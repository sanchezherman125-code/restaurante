import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi, preparationApi } from "../api/endpoints";
import { ConfirmDialog, Modal } from "../components/Modal";
import { EmptyState, Spinner } from "../components/Layout";
import { formatElapsed, useElapsed, useLateItems } from "../hooks/useElapsed";
import { errorMessage, sendOrQueue } from "../lib/send";
import type { BoardTask, ItemGroup, MenuItem } from "../types/api";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";

const AREA_LABEL: Record<string, string> = { KITCHEN: "Cocina", GRILL: "Parrilla" };
const AREA_SUMMARY: Record<string, string> = { PENDING: "pendiente", PREPARING: "preparando", READY: "listo", EMPTY: "sin tareas" };

const TASK_LABEL: Record<string, string> = {
  PENDING: "pendiente",
  PREPARING: "preparando",
  READY: "listo",
  CANCELLED: "cancelado",
};

function TaskLine({
  task,
  updating,
  onStatus,
  onCancel,
}: {
  task: BoardTask;
  updating: boolean;
  onStatus: (task: BoardTask, status: string) => void;
  onCancel: (task: BoardTask) => void;
}) {
  const elapsed = useElapsed(task.started_at ?? task.created_at);
  const expected = (task.expected_minutes ?? 0) * 60;
  const open = task.status === "PENDING" || task.status === "PREPARING";
  const late = expected > 0 && elapsed > expected && open;
  const warn = expected > 0 && elapsed > expected * 0.8 && !late && open;
  const waitingFor = task.status === "READY" && task.item_status !== "READY" && task.item_status !== "DELIVERED"
    ? task.other_tasks.filter((other) => other.status !== "READY")
    : [];

  return (
    <div className="item-row" data-testid="prep-task" data-task={task.name}>
      <span className="qty">×{task.quantity}</span>
      <div className="name">
        <div style={{ fontWeight: 700 }}>{task.name}</div>
        {task.item_name !== task.name ? <div className="hint">{task.item_name}</div> : null}
        {task.notes ? <div className="hint">📝 {task.notes}</div> : null}
        {task.replacement_description ? <div className="hint">🔁 {task.replacement_description}</div> : null}
        <div className="row wrap" style={{ marginTop: 6 }}>
          <span className={`timer ${late ? "late" : warn ? "warn" : ""}`}>{formatElapsed(elapsed)}</span>
          {expected > 0 ? <span className="hint">/ {task.expected_minutes} min</span> : null}
          <span className={`chip ${task.status === "PREPARING" ? "info" : task.status === "READY" ? "success" : "warning"}`}>
            {TASK_LABEL[task.status] ?? task.status}
          </span>
        </div>
        {task.other_tasks.length > 0 ? (
          <div className="row wrap" style={{ marginTop: 6 }}>
            {task.other_tasks.map((other) => (
              <span key={other.id} className={`chip ${other.status === "READY" ? "success" : ""}`}>
                {AREA_LABEL[other.area] ?? other.area}: {TASK_LABEL[other.status] ?? other.status}
              </span>
            ))}
          </div>
        ) : null}
        {waitingFor.length > 0 ? (
          <div className="hint" style={{ marginTop: 4 }}>
            Esperando a {[...new Set(waitingFor.map((other) => AREA_LABEL[other.area] ?? other.area))].join(" y ")}
          </div>
        ) : null}
        <div className="row wrap" style={{ marginTop: 8 }}>
          {task.status === "PENDING" ? (
            <button className="btn small" disabled={updating} onClick={() => onStatus(task, "PREPARING")}>
              ▶ Empezar
            </button>
          ) : null}
          {task.status === "PREPARING" ? (
            <button className="btn success small" disabled={updating} onClick={() => onStatus(task, "READY")}>
              ✓ Listo
            </button>
          ) : null}
          {task.item_status === "PENDING" || task.item_status === "PREPARING" ? (
            <button className="btn ghost small" disabled={updating} onClick={() => onCancel(task)}>
              Cancelar plato
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
  const [cancelTarget, setCancelTarget] = useState<BoardTask | null>(null);
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  const [updatingTasks, setUpdatingTasks] = useState<Record<string, string>>({});

  const key = area === "GRILL" ? "grill" : "kitchen";
  const groups = useQuery({
    queryKey: ["preparation", key],
    queryFn: () => (area === "GRILL" ? preparationApi.grill() : preparationApi.kitchen()),
    refetchInterval: 15000,
    retry: false,
  });

  async function changeStatus(task: BoardTask, status: string) {
    if (updatingTasks[task.id] && updatingTasks[task.id] !== task.status) return;
    setUpdatingTasks((current) => ({ ...current, [task.id]: status }));
    let queued = false;
    let completed = false;
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "UPDATE_PREPARATION_TASK",
          path: `/api/v1/orders/${task.order_id}/items/${task.order_item_id}/tasks/${task.id}/status`,
          method: "POST",
          body: { status },
        },
        (clientOperationId) =>
          preparationApi.setTaskStatus(task.order_id, task.order_item_id, task.id, status, clientOperationId),
      );
      queued = outcome.queued;
      completed = true;
      if (!queued) void queryClient.invalidateQueries({ queryKey: ["preparation"] });
    } catch (error) {
      toast("error", "No se pudo actualizar", errorMessage(error));
    } finally {
      if (!queued && !completed) {
        setUpdatingTasks((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      }
    }
  }

  async function cancelDish(task: BoardTask) {
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "CANCEL_ORDER_ITEM",
          path: `/api/v1/orders/${task.order_id}/items/${task.order_item_id}/cancel`,
          method: "POST",
          body: { reason: `Cancelado en ${AREA_LABEL[area]}` },
        },
        (operationId) =>
          ordersApi.cancelItem(task.order_id, task.order_item_id, `Cancelado en ${AREA_LABEL[area]}`, operationId),
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
              onStatus={(task, status) => void changeStatus(task, status)}
              onCancel={(task) => setCancelTarget(task)}
              updatingTasks={updatingTasks}
            />
          ))}
        </div>
      )}

      {cancelTarget ? (
        <ConfirmDialog
          title="Cancelar plato"
          message={`¿Cancelar ${cancelTarget.quantity} × ${cancelTarget.item_name}? Se cancela el plato completo${
            cancelTarget.other_tasks.length > 0 ? ", también en las otras áreas que participan," : ""
          } y se avisa al mesero. Queda registrado en auditoría.`}
          confirmLabel="Cancelar plato"
          danger
          onConfirm={() => void cancelDish(cancelTarget)}
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
  updatingTasks,
}: {
  group: ItemGroup;
  onStatus: (task: BoardTask, status: string) => void;
  onCancel: (task: BoardTask) => void;
  updatingTasks: Record<string, string>;
}) {
  const elapsed = useElapsed(group.created_at);
  const latenessInput = useMemo(
    () =>
      group.tasks.map((task) => ({
        id: task.id,
        expectedMinutes: task.expected_minutes,
        startedAt: task.started_at,
        createdAt: task.created_at,
        status: task.status,
      })),
    [group.tasks],
  );
  const lateIds = useLateItems(latenessInput);
  const anyLate = lateIds.size > 0;
  const allReady = group.tasks.every((task) => task.status === "READY" || task.status === "CANCELLED");

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
              {AREA_LABEL[areaName] ?? areaName}: {AREA_SUMMARY[status] ?? status}
            </span>
          ))}
        </div>
        {group.notes ? <div className="hint">🗒️ {group.notes}</div> : null}
        {group.command_notes ? <div className="hint">📝 {group.command_notes}</div> : null}
        {group.tasks.map((task) => (
          <TaskLine
            key={task.id}
            task={task}
            updating={Boolean(updatingTasks[task.id] && updatingTasks[task.id] !== task.status)}
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

  const items = (menu.data?.items ?? []).filter(
    (item) =>
      item.is_active &&
      (item.preparation_steps?.length
        ? item.preparation_steps.some((step) => step.is_active && step.area === area)
        : item.preparation_area === area),
  );

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
