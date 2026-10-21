import logging
import mimetypes
import re
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, File, UploadFile
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.core.deps import DbSession, StaffUser
from app.core.errors import ApiError, ForbiddenError, NotFoundError, ValidationAppError
from app.models import Expense, PushSubscription, Receipt
from app.schemas.ops import PushSubscriptionCreate, ReceiptUploadOut

logger = logging.getLogger("app.receipts")
router = APIRouter(tags=["receipts"])

UPLOAD_DIR = Path(__file__).resolve().parent.parent.parent / "uploads"
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
EXPECTED_MIMES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
}


def _matches_signature(data: bytes, content_type: str) -> bool:
    if content_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/webp":
        return len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    if content_type == "application/pdf":
        return data.startswith(b"%PDF-")
    return False


def _validate(file: UploadFile) -> None:
    content_type = (file.content_type or "").lower()
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValidationAppError(
            "INVALID_FILE_EXTENSION",
            "Formato no admitido. Use JPG, JPEG, PNG, WEBP o PDF.",
            {"allowed": sorted(ALLOWED_EXTENSIONS)},
        )
    if content_type not in settings.allowed_receipt_mimes:
        raise ValidationAppError("INVALID_MIME_TYPE", "Tipo de archivo no admitido.", {"content_type": content_type})
    if EXPECTED_MIMES[ext] != content_type:
        raise ValidationAppError("MIME_EXTENSION_MISMATCH", "El MIME no coincide con la extensión del comprobante.")


async def _upload_supabase(data: bytes, filename: str, content_type: str) -> str | None:
    if not settings.supabase_url or not settings.supabase_service_key:
        return None
    url = f"{settings.supabase_url.rstrip('/')}/storage/v1/object/{settings.supabase_storage_bucket}/{filename}"
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "apikey": settings.supabase_service_key,
        "Content-Type": content_type,
        "x-upsert": "false",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, content=data, headers=headers)
        response.raise_for_status()
    return f"/api/v1/receipts/{filename}"


@router.post("/receipts", response_model=ReceiptUploadOut, status_code=201)
async def upload_receipt(db: DbSession, user: StaffUser, file: UploadFile = File(...)) -> ReceiptUploadOut:
    _validate(file)
    data = await file.read(settings.max_receipt_bytes + 1)
    if not data:
        raise ValidationAppError("EMPTY_FILE", "El archivo está vacío.")
    if len(data) > settings.max_receipt_bytes:
        raise ValidationAppError(
            "FILE_TOO_LARGE",
            f"El archivo supera el máximo de {settings.max_receipt_bytes // (1024 * 1024)} MB.",
        )
    if not _matches_signature(data, file.content_type or ""):
        raise ValidationAppError(
            "INVALID_FILE_CONTENT", "El contenido no corresponde al tipo de comprobante declarado."
        )

    ext = Path(file.filename or "receipt").suffix.lower()
    filename = f"{uuid.uuid4().hex}{ext}"
    content_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    try:
        url = await _upload_supabase(data, filename, content_type)
    except httpx.HTTPError as exc:
        raise ApiError(502, "STORAGE_UNAVAILABLE", "No se pudo guardar el comprobante. Intente nuevamente.") from exc
    if url is None:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        (UPLOAD_DIR / filename).write_bytes(data)
        url = f"/api/v1/receipts/{filename}"

    db.add(Receipt(filename=filename, user_id=user.id, content_type=content_type, size=len(data)))
    db.commit()

    return ReceiptUploadOut(url=url, content_type=content_type, size=len(data))


@router.get("/receipts/{filename}")
async def download_receipt(filename: str, db: DbSession, user: StaffUser) -> Response:
    if not re.fullmatch(r"[0-9a-f]{32}\.(?:jpg|jpeg|png|webp|pdf)", filename):
        raise NotFoundError("RECEIPT_NOT_FOUND", "Comprobante no encontrado.")
    receipt = db.get(Receipt, filename)
    if user.role != "ADMIN":
        owned_expense = (
            db.query(Expense.id)
            .filter(
                Expense.created_by_user_id == user.id,
                Expense.receipt_url.in_([f"/api/v1/receipts/{filename}", f"/uploads/{filename}"]),
            )
            .first()
        )
        if (receipt is None or receipt.user_id != user.id) and not owned_expense:
            raise ForbiddenError("RECEIPT_FORBIDDEN", "No tiene permiso para ver este comprobante.")
    headers = {"Cache-Control": "private, no-store", "Content-Disposition": f'inline; filename="{filename}"'}
    content_type = receipt.content_type if receipt else mimetypes.guess_type(filename)[0]
    if settings.supabase_url and settings.supabase_service_key:
        url = (
            f"{settings.supabase_url.rstrip('/')}/storage/v1/object/authenticated/"
            f"{settings.supabase_storage_bucket}/{filename}"
        )
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                result = await client.get(
                    url,
                    headers={
                        "Authorization": f"Bearer {settings.supabase_service_key}",
                        "apikey": settings.supabase_service_key,
                    },
                )
                result.raise_for_status()
        except httpx.HTTPError as exc:
            raise ApiError(502, "STORAGE_UNAVAILABLE", "No se pudo obtener el comprobante.") from exc
        return Response(result.content, media_type=content_type, headers=headers)
    path = UPLOAD_DIR / filename
    if not path.is_file():
        raise NotFoundError("RECEIPT_NOT_FOUND", "Comprobante no encontrado.")
    return FileResponse(path, media_type=content_type, headers=headers)


@router.post("/push/subscriptions", status_code=201)
def save_push_subscription(payload: PushSubscriptionCreate, db: DbSession, user: StaffUser) -> dict:
    existing = db.query(PushSubscription).filter(PushSubscription.endpoint == payload.endpoint).first()
    if existing is None:
        db.add(PushSubscription(user_id=user.id, endpoint=payload.endpoint, keys=payload.keys))
    else:
        existing.keys = payload.keys
        existing.user_id = user.id
    db.commit()
    return {"status": "ok"}
