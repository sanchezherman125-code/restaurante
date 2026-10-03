from typing import Any


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}

    def to_payload(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class ConflictError(ApiError):
    def __init__(
        self,
        code: str = "CONFLICT",
        message: str = "Conflicto con el estado actual.",
        details: dict | None = None,
    ):
        super().__init__(409, code, message, details)


class NotFoundError(ApiError):
    def __init__(self, code: str = "NOT_FOUND", message: str = "Recurso no encontrado.", details: dict | None = None):
        super().__init__(404, code, message, details)


class ForbiddenError(ApiError):
    def __init__(
        self,
        code: str = "FORBIDDEN",
        message: str = "No tiene permisos para esta operación.",
        details: dict | None = None,
    ):
        super().__init__(403, code, message, details)


class UnauthorizedError(ApiError):
    def __init__(self, code: str = "UNAUTHORIZED", message: str = "No autenticado.", details: dict | None = None):
        super().__init__(401, code, message, details)


class ValidationAppError(ApiError):
    def __init__(self, code: str = "VALIDATION_ERROR", message: str = "Datos inválidos.", details: dict | None = None):
        super().__init__(422, code, message, details)
