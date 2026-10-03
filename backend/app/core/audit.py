from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import AuditLog

LOGIN = "LOGIN"
ORDER_CREATED = "ORDER_CREATED"
COMMAND_CREATED = "COMMAND_CREATED"
ITEM_ADDED = "ITEM_ADDED"
ITEM_CANCELLED = "ITEM_CANCELLED"
ITEM_STATUS_CHANGED = "ITEM_STATUS_CHANGED"
EXPENSE_CREATED = "EXPENSE_CREATED"
PAYMENT_REGISTERED = "PAYMENT_REGISTERED"
MENU_PRICE_CHANGED = "MENU_PRICE_CHANGED"
AVAILABILITY_CHANGED = "AVAILABILITY_CHANGED"
SHIFT_CLOSED = "SHIFT_CLOSED"


def audit(
    db: Session,
    *,
    user_id: UUID | None,
    action: str,
    entity_type: str,
    entity_id: str | UUID | None = None,
    before_data: dict[str, Any] | None = None,
    after_data: dict[str, Any] | None = None,
    device_id: str | None = None,
) -> None:
    log = AuditLog(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        before_data=before_data,
        after_data=after_data,
        device_id=device_id,
    )
    db.add(log)
