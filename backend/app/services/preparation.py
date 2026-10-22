"""Tareas internas de preparación de un plato.

El plato comercial (``OrderItem``) es lo que se cobra; las tareas (``OrderItemPreparationTask``) son
el trabajo de cada área. El estado del plato se *deriva* de sus tareas en ``refresh_item_from_tasks``,
que es el único punto donde un plato pasa a ``READY``. Todas las funciones asumen que el llamador ya
bloqueó turno → pedido → plato (``lock_order_and_shift`` / ``lock_order_item``).
"""

from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import CursorResult, text
from sqlalchemy.orm import Session

from app.core.errors import ConflictError
from app.models import MenuItem, MenuPreparationStep, OrderItem, OrderItemPreparationTask
from app.models.enums import ItemStatus, PreparationArea, TaskStatus

PREPARATION_AREAS = (PreparationArea.KITCHEN.value, PreparationArea.GRILL.value)
AREA_CHANNEL = {PreparationArea.KITCHEN.value: "kitchen", PreparationArea.GRILL.value: "grill"}
ROLE_AREA = {"KITCHEN": PreparationArea.KITCHEN.value, "GRILL": PreparationArea.GRILL.value}
# Las tareas solo avanzan: un mensaje atrasado nunca puede devolver una tarea a un estado anterior.
RANK = {TaskStatus.PENDING.value: 0, TaskStatus.PREPARING.value: 1, TaskStatus.READY.value: 2}


@dataclass(frozen=True)
class StepSpec:
    name: str
    area: str
    expected_minutes: int | None
    sort_order: int
    menu_step_id: UUID | None = None


def steps_for_menu_item(menu_item: MenuItem, steps: list[MenuPreparationStep]) -> list[StepSpec]:
    """Receta vigente del producto; si no tiene pasos se genera la tarea única equivalente."""
    active = sorted((s for s in steps if s.is_active), key=lambda s: (s.sort_order, str(s.id)))
    if active:
        return [StepSpec(s.name, s.area, s.expected_minutes, s.sort_order, s.id) for s in active]
    if menu_item.preparation_area in PREPARATION_AREAS:
        return [StepSpec(menu_item.name, menu_item.preparation_area, menu_item.expected_prep_minutes, 0)]
    raise ConflictError(
        "MENU_ITEM_NOT_CONFIGURED",
        f"'{menu_item.name}' requiere preparación pero no tiene tareas configuradas.",
        {"menu_item_id": str(menu_item.id)},
    )


def load_steps(db: Session, menu_item_id: UUID) -> list[MenuPreparationStep]:
    return db.query(MenuPreparationStep).filter(MenuPreparationStep.menu_item_id == menu_item_id).all()


def sync_menu_steps(db: Session, menu_item: MenuItem, steps_in: list) -> None:
    """Reemplaza la receta del producto conservando el id de los pasos editados.

    Los pedidos ya registrados no se ven afectados: sus tareas son copias (``menu_step_id`` pasa a NULL
    si el paso se elimina) y nunca se leen de nuevo del catálogo.
    """
    existing = {s.id: s for s in menu_item.preparation_steps}
    keep: list[MenuPreparationStep] = []
    for index, data in enumerate(steps_in):
        step = existing.get(data.id) if data.id else None
        if data.id and step is None:
            raise ConflictError("PREPARATION_STEP_NOT_FOUND", "La tarea indicada no pertenece a este producto.")
        if step is None:
            step = MenuPreparationStep(menu_item_id=menu_item.id)
        step.name = data.name
        step.area = data.area.value
        step.expected_minutes = data.expected_minutes
        step.sort_order = index
        step.is_active = data.is_active
        keep.append(step)
    menu_item.preparation_steps[:] = keep
    refresh_menu_summary(menu_item)


def refresh_menu_summary(menu_item: MenuItem) -> None:
    """Mantiene ``preparation_area``/``expected_prep_minutes`` como resumen de la receta (tiempo crítico)."""
    if not menu_item.requires_preparation:
        menu_item.preparation_area = None
        menu_item.expected_prep_minutes = None
        return
    active = sorted((s for s in menu_item.preparation_steps if s.is_active), key=lambda s: s.sort_order)
    if not active:
        return
    minutes = [s.expected_minutes for s in active if s.expected_minutes is not None]
    menu_item.preparation_area = active[0].area
    menu_item.expected_prep_minutes = max(minutes) if minutes else None


def attach_tasks(item: OrderItem, specs: list[StepSpec]) -> None:
    """Copia la receta al plato y fija el resumen comercial (área principal y tiempo crítico)."""
    for spec in specs:
        item.tasks.append(
            OrderItemPreparationTask(
                menu_step_id=spec.menu_step_id,
                name=spec.name,
                area=spec.area,
                expected_minutes=spec.expected_minutes,
                sort_order=spec.sort_order,
                status=TaskStatus.PENDING.value,
            )
        )
    item.preparation_area = specs[0].area
    minutes = [s.expected_minutes for s in specs if s.expected_minutes is not None]
    # Las tareas corren en paralelo: el tiempo del plato es el de la tarea más larga.
    item.expected_prep_minutes_snapshot = max(minutes) if minutes else None


def live_tasks(item: OrderItem) -> list[OrderItemPreparationTask]:
    return [t for t in item.tasks if t.status != TaskStatus.CANCELLED]


def item_areas(item: OrderItem) -> set[str]:
    return {t.area for t in live_tasks(item)}


def authorized_areas(item: OrderItem) -> set[str]:
    """Áreas con permiso sobre el plato; un plato sin tareas aún (despliegue en curso) usa su área resumen."""
    areas = item_areas(item)
    if not areas and item.requires_preparation and item.preparation_area in PREPARATION_AREAS:
        areas = {item.preparation_area}
    return areas


def all_item_areas(item: OrderItem) -> set[str]:
    """Áreas que tuvieron trabajo en el plato, incluso si luego se canceló."""
    return {t.area for t in item.tasks}


def item_channels(item: OrderItem) -> set[str]:
    channels = {"admin"}
    channels.update(AREA_CHANNEL[a] for a in item_areas(item) if a in AREA_CHANNEL)
    return channels


def lock_item_tasks(db: Session, item_id: UUID) -> list[OrderItemPreparationTask]:
    return (
        db.query(OrderItemPreparationTask)
        .filter(OrderItemPreparationTask.order_item_id == item_id)
        .order_by(OrderItemPreparationTask.sort_order, OrderItemPreparationTask.id)
        .populate_existing()
        .with_for_update()
        .all()
    )


MIRROR_STATUS_SQL = """CASE {s} WHEN 'PREPARING' THEN 'PREPARING' WHEN 'READY' THEN 'READY'
    WHEN 'DELIVERED' THEN 'READY' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'PENDING' END"""

# Tarea espejo (derivada del plato). El índice parcial ``uq_prep_tasks_legacy_mirror`` hace que relleno,
# reparación y trigger de la BD no puedan duplicarla aunque corran a la vez: el perdedor no inserta nada.
_MIRROR_INSERT = f"""
    INSERT INTO order_item_preparation_tasks
        (id, order_item_id, menu_step_id, name, area, expected_minutes, sort_order, status,
         started_at, ready_at, cancelled_at, legacy_mirror, created_at, updated_at)
    SELECT gen_random_uuid(), oi.id, NULL, oi.menu_item_name_snapshot, oi.preparation_area,
           CASE WHEN oi.expected_prep_minutes_snapshot IS NULL THEN NULL
                ELSE GREATEST(0, LEAST(600, oi.expected_prep_minutes_snapshot)) END,
           0, {MIRROR_STATUS_SQL.format(s="oi.status")},
           oi.preparation_started_at, oi.ready_at, oi.cancelled_at, TRUE, oi.created_at, oi.updated_at
    FROM order_items oi
    WHERE oi.requires_preparation IS TRUE AND oi.preparation_area IN ('KITCHEN', 'GRILL')
      AND NOT EXISTS (SELECT 1 FROM order_item_preparation_tasks t WHERE t.order_item_id = oi.id)
"""
_ON_CONFLICT = "ON CONFLICT (order_item_id) WHERE legacy_mirror DO NOTHING"


def ensure_item_tasks(db: Session, item: OrderItem) -> None:
    """Un plato sin tareas (escrito por un backend anterior) recibe su tarea equivalente, sin duplicarla."""
    if not item.requires_preparation or item.tasks or item.status == ItemStatus.CANCELLED:
        return
    if item.preparation_area not in PREPARATION_AREAS:
        return
    db.execute(text(_MIRROR_INSERT + " AND oi.id = :item " + _ON_CONFLICT), {"item": item.id})
    db.expire(item, ["tasks"])


def advance_tasks(tasks: list[OrderItemPreparationTask], new_status: TaskStatus, now: datetime) -> list:
    """Avanza tareas un paso. Repetir o retrasar un estado es una operación nula; saltarse un paso falla."""
    target = RANK[new_status.value]
    changed: list[OrderItemPreparationTask] = []
    for task in tasks:
        if task.status == TaskStatus.CANCELLED:
            raise ConflictError(
                "INVALID_STATUS_TRANSITION",
                f"La tarea '{task.name}' está cancelada.",
                {"current": task.status, "requested": new_status.value},
            )
        current = RANK[task.status]
        if current >= target:
            continue
        if current != target - 1:
            raise ConflictError(
                "INVALID_STATUS_TRANSITION",
                f"Transición no permitida: {task.status} → {new_status.value}.",
                {"current": task.status, "requested": new_status.value},
            )
        if new_status == TaskStatus.PREPARING:
            task.started_at = task.started_at or now
        else:
            task.started_at = task.started_at or now
            task.ready_at = now
        task.status = new_status.value
        changed.append(task)
    return changed


@dataclass
class ItemRefresh:
    became_preparing: bool = False
    became_ready: bool = False


def refresh_item_from_tasks(item: OrderItem, now: datetime) -> ItemRefresh:
    """Deriva el estado comercial del plato. Única transición hacia ``READY`` (corre bajo bloqueo del plato)."""
    result = ItemRefresh()
    tasks = live_tasks(item)
    if not tasks or item.status not in (ItemStatus.PENDING, ItemStatus.PREPARING):
        return result
    started = [t.started_at for t in tasks if t.started_at is not None]
    if started and item.preparation_started_at is None:
        item.preparation_started_at = min(started)
    if item.status == ItemStatus.PENDING and any(t.status != TaskStatus.PENDING for t in tasks):
        item.status = ItemStatus.PREPARING
        result.became_preparing = True
    if all(t.status == TaskStatus.READY for t in tasks):
        item.status = ItemStatus.READY
        item.ready_at = max((t.ready_at for t in tasks if t.ready_at), default=now)
        result.became_ready = True
    return result


def cancel_tasks(item: OrderItem, now: datetime) -> None:
    for task in item.tasks:
        if task.status != TaskStatus.CANCELLED:
            task.status = TaskStatus.CANCELLED
            task.cancelled_at = now


def tasks_in_areas(item: OrderItem, areas: set[str]) -> list[OrderItemPreparationTask]:
    return [t for t in live_tasks(item) if t.area in areas]


BACKFILL_TASKS_SQL = text(_MIRROR_INSERT + _ON_CONFLICT)


def backfill_missing_tasks(db: Session) -> int:
    """Relleno de arranque (red de seguridad). Idempotente y seguro frente a procesos concurrentes."""
    result = cast("CursorResult", db.execute(BACKFILL_TASKS_SQL))
    count = result.rowcount
    db.commit()
    return count
