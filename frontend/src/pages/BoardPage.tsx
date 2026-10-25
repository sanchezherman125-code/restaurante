import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi, preparationApi } from "../api/endpoints";
import { Icon } from "../components/Icon";
import { ConfirmDialog, Modal } from "../components/Modal";
import { EmptyState, PageHeader, SkeletonList } from "../components/Layout";
import { formatElapsed, useElapsed, useNow } from "../hooks/useElapsed";
import { AREA_NAME, TASK_STATUS } from "../lib/labels";
import { errorMessage, sendOrQueue } from "../lib/send";
import type { BoardTask, ItemGroup, MenuItem } from "../types/api";
import { useQueue } from "../stores/queue";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";

const AREA_LABEL = AREA_NAME;

/** Calor de la tarea: avance contra el tiempo estimado. Comunica urgencia con barra, número y texto. */
function heat(elapsed: number, expectedMinutes: number | null, open: boolean): { ratio: number; level: "ok" | "warn" | "late" | "none" } {
  const expected = (expectedMinutes ?? 0) * 60;
  if (!open || expected <= 0) return { ratio: 0, level: "none" };
  const ratio = elapsed / expected;
  return { ratio: Math.min(1, ratio), level: ratio > 1 ? "late" : ratio > 0.8 ? "warn" : "ok" };
}

function TaskLine({ task, updating, cancellable, cancelQueued, onStatus, onCancel }: {
  task: BoardTask; updating: boolean; cancellable: boolean; cancelQueued: boolean;
  onStatus: (task: BoardTask, status: string) => void; onCancel: (task: BoardTask) => void;
}) {
  const elapsed = useElapsed(task.started_at ?? task.created_at);
  const open = task.status === "PENDING" || task.status === "PREPARING";
  const h = heat(elapsed, task.expected_minutes, open);
  const status = TASK_STATUS[task.status];
  const waitingFor = task.status === "READY" && task.item_status !== "READY" && task.item_status !== "DELIVERED"
    ? task.other_tasks.filter((other) => other.status !== "READY")
    : [];

  return (
    <div className={`task ${task.status.toLowerCase()}`} data-testid="prep-task" data-task={task.name}>
      <div className="task-main">
        <span className="task-qty num">×{task.quantity}</span>
        <div className="grow">
          <div className="task-name">{task.name}</div>
          {task.item_name !== task.name ? <div className="hint">{task.item_name}</div> : null}
          {task.notes ? <div className="task-note"><Icon name="note" />{task.notes}</div> : null}
          {task.replacement_description ? <div className="task-note"><Icon name="refresh" />{task.replacement_description}</div> : null}
        </div>
        <span className={`chip ${status.tone === "run" ? "info" : status.tone === "ok" ? "success" : "warning"}`}>
          <Icon name={status.icon} />{status.label.toLowerCase()}
        </span>
      </div>

      {open ? (
        <div className="heat" data-level={h.level}>
          <div className="heat-bar" aria-hidden="true"><span style={{ width: `${Math.round(h.ratio * 100)}%` }} /></div>
          <span className={`timer ${h.level === "late" ? "late" : h.level === "warn" ? "warn" : ""}`}>{formatElapsed(elapsed)}</span>
          {task.expected_minutes ? <span className="hint">de {task.expected_minutes} min{h.level === "late" ? " · atrasado" : ""}</span> : null}
        </div>
      ) : null}

      {task.other_tasks.length > 0 ? (
        <div className="row wrap" style={{ gap: "var(--s2)" }}>
          {task.other_tasks.map((other) => (
            <span key={other.id} className={`chip ${other.status === "READY" ? "success" : other.status === "PREPARING" ? "info" : ""}`}>
              <Icon name={TASK_STATUS[other.status].icon} />{AREA_LABEL[other.area] ?? other.area}: {TASK_STATUS[other.status].label.toLowerCase()}
            </span>
          ))}
        </div>
      ) : null}
      {waitingFor.length > 0 ? (
        <div className="waiting-note">
          <Icon name="hourglass" />Su parte está lista. Esperando a {[...new Set(waitingFor.map((other) => AREA_LABEL[other.area] ?? other.area))].join(" y ")}
        </div>
      ) : null}

      <div className="task-actions">
        {task.status === "PENDING" ? (
          <button className="btn large grow" disabled={updating} onClick={() => onStatus(task, "PREPARING")}><Icon name="play" />Empezar</button>
        ) : null}
        {task.status === "PREPARING" ? (
          <button className="btn success large grow" disabled={updating} onClick={() => onStatus(task, "READY")}><Icon name="check" />Listo</button>
        ) : null}
        {cancelQueued && (task.item_status === "PENDING" || task.item_status === "PREPARING") ? (
          <span className="chip warning" data-testid="cancel-queued"><Icon name="cloud" />Cancelación pendiente de envío</span>
        ) : cancellable && (task.item_status === "PENDING" || task.item_status === "PREPARING") ? (
          <button className="btn ghost small" disabled={updating} onClick={() => onCancel(task)}>Cancelar plato</button>
        ) : null}
      </div>
    </div>
  );
}

function groupTone(group: ItemGroup, now: number): "late" | "running" | "ready" | "waiting" {
  const live = group.tasks;
  const late = live.some((task) => {
    const expected = (task.expected_minutes ?? 0) * 60;
    const started = new Date(task.started_at ?? task.created_at).getTime();
    return expected > 0 && (task.status === "PENDING" || task.status === "PREPARING") && (now - started) / 1000 > expected;
  });
  if (late) return "late";
  if (live.every((task) => task.status === "READY")) return "ready";
  if (live.some((task) => task.status === "PREPARING")) return "running";
  return "waiting";
}

function GroupCard({ group, tone, onStatus, onCancel, updatingTasks, queuedCancels }: {
  group: ItemGroup; tone: "late" | "running" | "ready" | "waiting";
  onStatus: (task: BoardTask, status: string) => void; onCancel: (task: BoardTask) => void; updatingTasks: Record<string, string>;
  queuedCancels: Set<string>;
}) {
  const elapsed = useElapsed(group.created_at);
  return (
    <article className="ticket-card board-ticket" data-testid="prep-card" data-table={group.table_name ?? ""} data-tone={tone}>
      <div className="ticket-head">
        <strong>{group.table_name ?? (group.order_type === "TAKEAWAY" ? "Para llevar" : "Pedido")}</strong>
        <span className="chip">Comanda {group.sequence_number}</span>
        {group.persons_count ? <span className="chip"><Icon name="users" />{group.persons_count}</span> : null}
        <span className="grow" />
        <span className={`timer ${tone === "late" ? "late" : ""}`} title="Tiempo desde que llegó la comanda">{formatElapsed(elapsed)}</span>
      </div>
      <div className="ticket-body">
        {group.notes ? <div className="task-note"><Icon name="note" />{group.notes}</div> : null}
        {group.command_notes ? <div className="task-note"><Icon name="note" />{group.command_notes}</div> : null}
        {group.tasks.map((task) => (
          <TaskLine
            key={task.id}
            task={task}
            updating={Boolean(updatingTasks[task.id] && updatingTasks[task.id] !== task.status)}
            // Un pedido pagado se sigue preparando, pero el servidor ya no admite cancelar sus platos.
            cancellable={group.order_general_status !== "PAID"}
            cancelQueued={queuedCancels.has(task.order_item_id)}
            onStatus={onStatus}
            onCancel={onCancel}
          />
        ))}
      </div>
    </article>
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
      if (!outcome.queued) {
        void queryClient.invalidateQueries({ queryKey: ["preparation"] });
        toast("info", "Producto cancelado");
      }
    } catch (error) {
      toast("error", "No se pudo cancelar", errorMessage(error));
    } finally {
      setCancelTarget(null);
    }
  }

  const operations = useQueue((state) => state.operations);
  const queuedCancels = useMemo(() => new Set(operations
    .filter((op) => op.operation_type === "CANCEL_ORDER_ITEM" && (op.status === "LOCAL_PENDING" || op.status === "SENDING"))
    .map((op) => /\/items\/([^/]+)\/cancel$/.exec(op.path)?.[1])
    .filter((id): id is string => Boolean(id))), [operations]);

  const now = useNow(5000);
  const data = useMemo(() => {
    const rows = groups.data ?? [];
    // Prioridad operativa: atrasadas primero, luego en curso, luego pendientes, y por último las que solo esperan a otra área.
    const rank = { late: 0, running: 1, waiting: 2, ready: 3 } as const;
    return rows
      .map((group) => ({ group, tone: groupTone(group, now) }))
      .sort((a, b) => rank[a.tone] - rank[b.tone] || a.group.created_at.localeCompare(b.group.created_at));
  }, [groups.data, now]);

  const totals = useMemo(() => {
    const tasks = (groups.data ?? []).flatMap((group) => group.tasks);
    return {
      pending: tasks.filter((task) => task.status === "PENDING").length,
      preparing: tasks.filter((task) => task.status === "PREPARING").length,
      ready: tasks.filter((task) => task.status === "READY").length,
    };
  }, [groups.data]);

  if (groups.isLoading) return <div className="board"><PageHeader title={`${AREA_LABEL[area]} · comandas`} /><SkeletonList rows={3} height={180} label="Cargando comandas" /></div>;

  return (
    <div className="board">
      <PageHeader
        title={`${AREA_LABEL[area]} · comandas`}
        subtitle={
          <span className="board-totals" role="status">
            <span className="chip warning"><Icon name="hourglass" />{totals.pending} {totals.pending === 1 ? "pendiente" : "pendientes"}</span>
            <span className="chip info"><Icon name="flame" />{totals.preparing} preparando</span>
            <span className="chip success"><Icon name="check" />{totals.ready} {totals.ready === 1 ? "lista" : "listas"}</span>
          </span>
        }
        actions={
          <>
            <button className="btn ghost small" onClick={() => setSoldOutOpen(true)}><Icon name="ban" />Agotados</button>
            <button className="btn secondary small" onClick={() => void groups.refetch()} aria-label="Actualizar comandas"><Icon name="refresh" /></button>
          </>
        }
      />

      {data.length === 0 ? (
        <EmptyState icon="check" title="No hay comandas pendientes" hint="Las nuevas comandas aparecerán solas, con aviso." />
      ) : (
        <div className="board-grid">
          {data.map(({ group, tone }) => (
            <GroupCard
              key={group.command_id}
              group={group}
              tone={tone}
              onStatus={(task, status) => void changeStatus(task, status)}
              onCancel={(task) => setCancelTarget(task)}
              updatingTasks={updatingTasks}
              queuedCancels={queuedCancels}
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
    <div className="page wide" style={{ gap: "var(--s4)" }}>
      {role === "ADMIN" ? (
        <div className="segmented" role="group" aria-label="Área de preparación" style={{ alignSelf: "flex-start" }}>
          <button className={area === "KITCHEN" ? "active" : ""} aria-pressed={area === "KITCHEN"} onClick={() => setAdminArea("KITCHEN")}>
            <Icon name="kitchen" />Cocina
          </button>
          <button className={area === "GRILL" ? "active" : ""} aria-pressed={area === "GRILL"} onClick={() => setAdminArea("GRILL")}>
            <Icon name="flame" />Parrilla
          </button>
        </div>
      ) : null}
      <Board area={area} />
    </div>
  );
}
