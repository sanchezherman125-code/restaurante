from uuid import UUID

from fastapi import APIRouter, Query

from app.core import audit as audit_actions
from app.core.deps import AdminUser, AreaUser, DbSession, StaffUser
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.models import MenuCategory, MenuItem
from app.models.enums import AvailabilityStatus, PreparationArea
from app.schemas.menu import (
    AvailabilityUpdate,
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    MenuItemCreate,
    MenuItemOut,
    MenuItemUpdate,
    MenuOut,
    PreparationStepIn,
)
from app.services import preparation as prep
from app.ws.hub import hub

router = APIRouter(prefix="/menu", tags=["menu"])


def _item_out(item: MenuItem) -> MenuItemOut:
    out = MenuItemOut.model_validate(item)
    out.availability_status = AvailabilityStatus.AVAILABLE if item.is_available else AvailabilityStatus.SOLD_OUT
    return out


@router.get("", response_model=MenuOut)
def get_menu(
    db: DbSession,
    user: StaffUser,
    include_inactive: bool = Query(default=False),
) -> MenuOut:
    """Carta vendible: productos activos de categorías activas (lo mismo que acepta una comanda).

    ``include_inactive`` (solo administrador) devuelve también lo desactivado para poder reactivarlo.
    """
    if include_inactive and user.role != "ADMIN":
        raise ForbiddenError("MENU_INACTIVE_FORBIDDEN", "Solo el administrador ve la carta desactivada.")
    categories_query = db.query(MenuCategory)
    items_query = db.query(MenuItem)
    if not include_inactive:
        categories_query = categories_query.filter(MenuCategory.is_active.is_(True))
        items_query = items_query.join(MenuCategory, MenuCategory.id == MenuItem.category_id).filter(
            MenuItem.is_active.is_(True), MenuCategory.is_active.is_(True)
        )
    categories = categories_query.order_by(MenuCategory.sort_order.asc(), MenuCategory.name.asc()).all()
    items = items_query.order_by(MenuItem.name.asc()).all()
    return MenuOut(
        categories=[CategoryOut.model_validate(c) for c in categories],
        items=[_item_out(i) for i in items],
    )


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(db: DbSession, _: StaffUser) -> list[CategoryOut]:
    categories = db.query(MenuCategory).order_by(MenuCategory.sort_order.asc()).all()
    return [CategoryOut.model_validate(c) for c in categories]


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(payload: CategoryCreate, db: DbSession, _: AdminUser) -> CategoryOut:
    exists = db.query(MenuCategory).filter(MenuCategory.name == payload.name).first()
    if exists is not None:
        raise ConflictError("CATEGORY_EXISTS", "Ya existe una categoría con ese nombre.")
    category = MenuCategory(name=payload.name, sort_order=payload.sort_order, is_active=payload.is_active)
    db.add(category)
    db.commit()
    db.refresh(category)
    return CategoryOut.model_validate(category)


@router.patch("/categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: UUID, payload: CategoryUpdate, db: DbSession, _: AdminUser) -> CategoryOut:
    category = db.get(MenuCategory, category_id)
    if category is None:
        raise NotFoundError("CATEGORY_NOT_FOUND", "Categoría no encontrada.")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(category, key, value)
    db.commit()
    db.refresh(category)
    # Activar o desactivar una categoría cambia la carta de todos los dispositivos.
    hub.broadcast("menu.changed", {"category_id": str(category.id)}, {"admin", "waiters", "kitchen", "grill"})
    return CategoryOut.model_validate(category)


@router.post("/items", response_model=MenuItemOut, status_code=201)
def create_item(payload: MenuItemCreate, db: DbSession, _: AdminUser) -> MenuItemOut:
    category = db.get(MenuCategory, payload.category_id)
    if category is None:
        raise NotFoundError("CATEGORY_NOT_FOUND", "Categoría no encontrada.")
    data = payload.model_dump(exclude={"preparation_steps"})
    item = MenuItem(**data)
    db.add(item)
    db.flush()
    if item.requires_preparation:
        steps = payload.preparation_steps or [
            PreparationStepIn(
                name=payload.name,
                area=payload.preparation_area or PreparationArea.KITCHEN,
                expected_minutes=payload.expected_prep_minutes,
            )
        ]
        prep.sync_menu_steps(db, item, steps)
    db.commit()
    db.refresh(item)
    hub.broadcast("menu.changed", {"menu_item_id": str(item.id)}, {"admin", "waiters", "kitchen", "grill"})
    return _item_out(item)


@router.patch("/items/{item_id}", response_model=MenuItemOut)
def update_item(item_id: UUID, payload: MenuItemUpdate, db: DbSession, admin: AdminUser) -> MenuItemOut:
    item = db.get(MenuItem, item_id)
    if item is None:
        raise NotFoundError("MENU_ITEM_NOT_FOUND", "Producto no encontrado.")
    data = payload.model_dump(exclude_unset=True, exclude={"preparation_steps"})
    if "preparation_area" in data and data["preparation_area"] is not None:
        data["preparation_area"] = data["preparation_area"].value
    requires_preparation = data.get("requires_preparation", item.requires_preparation)
    preparation_area = data.get("preparation_area", item.preparation_area)
    steps_in = payload.preparation_steps
    legacy_area_or_time = bool({"preparation_area", "expected_prep_minutes"} & data.keys())
    if requires_preparation:
        if steps_in is None and (legacy_area_or_time or not item.preparation_steps):
            # Cliente que aún edita un solo área/tiempo: solo válido si la receta tiene a lo sumo una tarea.
            if len(item.preparation_steps) > 1 and legacy_area_or_time:
                raise ValidationAppError(
                    "PREPARATION_STEPS_REQUIRED",
                    "Este producto tiene varias tareas; edítelas en 'Preparación del producto'.",
                )
            if preparation_area not in ("KITCHEN", "GRILL"):
                raise ValidationAppError("PREPARATION_AREA_REQUIRED", "Seleccione KITCHEN o GRILL para este producto.")
            current = item.preparation_steps[0] if item.preparation_steps else None
            steps_in = [
                PreparationStepIn(
                    id=current.id if current else None,
                    name=current.name if current else data.get("name", item.name),
                    area=preparation_area,
                    expected_minutes=data.get("expected_prep_minutes", item.expected_prep_minutes),
                )
            ]
        elif steps_in is not None and not steps_in:
            raise ValidationAppError("PREPARATION_STEPS_REQUIRED", "Agregue al menos una tarea de preparación.")
    else:
        steps_in = []
        data["preparation_area"] = None
        data["expected_prep_minutes"] = None
    if "price" in data and data["price"] is not None and data["price"] != item.price:
        audit_actions.audit(
            db,
            user_id=admin.id,
            action=audit_actions.MENU_PRICE_CHANGED,
            entity_type="menu_items",
            entity_id=item.id,
            before_data={"price": str(item.price)},
            after_data={"price": str(data["price"])},
        )
    before_steps = [(s.name, s.area, s.expected_minutes, s.is_active) for s in item.preparation_steps]
    for key, value in data.items():
        setattr(item, key, value)
    if steps_in is not None:
        prep.sync_menu_steps(db, item, steps_in)
        after_steps = [(s.name, s.area, s.expected_minutes, s.is_active) for s in item.preparation_steps]
        if after_steps != before_steps:
            audit_actions.audit(
                db,
                user_id=admin.id,
                action=audit_actions.MENU_PREPARATION_CHANGED,
                entity_type="menu_items",
                entity_id=item.id,
                before_data={"steps": [list(s) for s in before_steps]},
                after_data={"steps": [list(s) for s in after_steps]},
            )
    db.commit()
    db.refresh(item)
    hub.broadcast("menu.changed", {"menu_item_id": str(item.id)}, {"admin", "waiters", "kitchen", "grill"})
    return _item_out(item)


@router.patch("/items/{item_id}/availability", response_model=MenuItemOut)
def set_availability(item_id: UUID, payload: AvailabilityUpdate, db: DbSession, user: AreaUser) -> MenuItemOut:
    item = db.get(MenuItem, item_id)
    if item is None:
        raise NotFoundError("MENU_ITEM_NOT_FOUND", "Producto no encontrado.")
    before = AvailabilityStatus.AVAILABLE if item.is_available else AvailabilityStatus.SOLD_OUT
    item.is_available = payload.status == AvailabilityStatus.AVAILABLE
    audit_actions.audit(
        db,
        user_id=user.id,
        action=audit_actions.AVAILABILITY_CHANGED,
        entity_type="menu_items",
        entity_id=item.id,
        before_data={"availability": before.value},
        after_data={"availability": payload.status.value},
    )
    db.commit()
    db.refresh(item)
    hub.broadcast(
        "availability.changed",
        {
            "menu_item_id": str(item.id),
            "name": item.name,
            "status": payload.status.value,
        },
        {"admin", "waiters", "kitchen", "grill"},
    )
    return _item_out(item)
