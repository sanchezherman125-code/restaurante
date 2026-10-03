from uuid import UUID

from fastapi import APIRouter

from app.core import audit as audit_actions
from app.core.deps import AdminUser, AreaUser, DbSession, StaffUser
from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import MenuCategory, MenuItem
from app.models.enums import AvailabilityStatus
from app.schemas.menu import (
    AvailabilityUpdate,
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    MenuItemCreate,
    MenuItemOut,
    MenuItemUpdate,
    MenuOut,
)
from app.ws.hub import hub

router = APIRouter(prefix="/menu", tags=["menu"])


def _item_out(item: MenuItem) -> MenuItemOut:
    out = MenuItemOut.model_validate(item)
    out.availability_status = AvailabilityStatus.AVAILABLE if item.is_available else AvailabilityStatus.SOLD_OUT
    return out


@router.get("", response_model=MenuOut)
def get_menu(db: DbSession, _: StaffUser) -> MenuOut:
    categories = (
        db.query(MenuCategory)
        .filter(MenuCategory.is_active.is_(True))
        .order_by(MenuCategory.sort_order.asc(), MenuCategory.name.asc())
        .all()
    )
    items = db.query(MenuItem).filter(MenuItem.is_active.is_(True)).order_by(MenuItem.name.asc()).all()
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
    return CategoryOut.model_validate(category)


@router.post("/items", response_model=MenuItemOut, status_code=201)
def create_item(payload: MenuItemCreate, db: DbSession, _: AdminUser) -> MenuItemOut:
    category = db.get(MenuCategory, payload.category_id)
    if category is None:
        raise NotFoundError("CATEGORY_NOT_FOUND", "Categoría no encontrada.")
    item = MenuItem(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return _item_out(item)


@router.patch("/items/{item_id}", response_model=MenuItemOut)
def update_item(item_id: UUID, payload: MenuItemUpdate, db: DbSession, _: AdminUser) -> MenuItemOut:
    item = db.get(MenuItem, item_id)
    if item is None:
        raise NotFoundError("MENU_ITEM_NOT_FOUND", "Producto no encontrado.")
    data = payload.model_dump(exclude_unset=True)
    if "preparation_area" in data and data["preparation_area"] is not None:
        data["preparation_area"] = data["preparation_area"].value
    requires_preparation = data.get("requires_preparation", item.requires_preparation)
    preparation_area = data.get("preparation_area", item.preparation_area)
    if requires_preparation:
        if preparation_area not in ("KITCHEN", "GRILL"):
            raise ValidationAppError("PREPARATION_AREA_REQUIRED", "Seleccione KITCHEN o GRILL para este producto.")
    else:
        data["preparation_area"] = None
        data["expected_prep_minutes"] = None
    if "price" in data and data["price"] is not None and data["price"] != item.price:
        audit_actions.audit(
            db,
            user_id=None,
            action=audit_actions.MENU_PRICE_CHANGED,
            entity_type="menu_items",
            entity_id=item.id,
            before_data={"price": str(item.price)},
            after_data={"price": str(data["price"])},
        )
    for key, value in data.items():
        setattr(item, key, value)
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
