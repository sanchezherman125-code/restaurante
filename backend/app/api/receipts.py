import logging
import mimetypes
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, File, UploadFile

from app.config import settings
from app.core.deps import DbSession, StaffUser
from app.core.errors import ValidationAppError
from app.models import PushSubscription
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
        "x-upsert": "true",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.put(url, content=data, headers=headers)
        response.raise_for_status()
    return f"{settings.supabase_url.rstrip('/')}/storage/v1/object/public/{settings.supabase_storage_bucket}/{filename}"


@router.post("/receipts", response_model=ReceiptUploadOut, status_code=201)
async def upload_receipt(user: StaffUser, file: UploadFile = File(...)) -> ReceiptUploadOut:
    _validate(file)
    data = await file.read()
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

    url = await _upload_supabase(data, filename, content_type)
    if url is None:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        (UPLOAD_DIR / filename).write_bytes(data)
        url = f"/uploads/{filename}"

    return ReceiptUploadOut(url=url, content_type=content_type, size=len(data))


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
