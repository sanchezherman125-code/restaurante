import enum


class Role(enum.StrEnum):
    WAITER = "WAITER"
    KITCHEN = "KITCHEN"
    GRILL = "GRILL"
    ADMIN = "ADMIN"


class PreparationArea(enum.StrEnum):
    KITCHEN = "KITCHEN"
    GRILL = "GRILL"
    WAITER = "WAITER"


class OrderType(enum.StrEnum):
    DINE_IN = "DINE_IN"
    TAKEAWAY = "TAKEAWAY"
    DELIVERY = "DELIVERY"


class OrderStatus(enum.StrEnum):
    OPEN = "OPEN"
    IN_PREPARATION = "IN_PREPARATION"
    READY = "READY"
    DELIVERED = "DELIVERED"
    PAID = "PAID"
    CLOSED = "CLOSED"


class ItemStatus(enum.StrEnum):
    PENDING = "PENDING"
    PREPARING = "PREPARING"
    READY = "READY"
    DELIVERED = "DELIVERED"
    CANCELLED = "CANCELLED"


class AvailabilityStatus(enum.StrEnum):
    AVAILABLE = "AVAILABLE"
    SOLD_OUT = "SOLD_OUT"


class PaymentMethod(enum.StrEnum):
    CASH = "CASH"
    YAPE = "YAPE"
    PLIN = "PLIN"
    CARD = "CARD"
    OTHER = "OTHER"


class ShiftStatus(enum.StrEnum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"


class SplitType(enum.StrEnum):
    BY_ITEMS = "BY_ITEMS"
    BY_AMOUNT = "BY_AMOUNT"


class SyncStatus(enum.StrEnum):
    LOCAL_PENDING = "LOCAL_PENDING"
    SENDING = "SENDING"
    SYNCED = "SYNCED"
    SYNC_ERROR = "SYNC_ERROR"
