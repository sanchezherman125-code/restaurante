from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import Role


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    pin: str = Field(min_length=4, max_length=12, pattern=r"^\d{4,10}$")
    device_id: str | None = Field(default=None, max_length=64)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    username: str
    display_name: str
    role: Role
    is_active: bool
    created_at: datetime


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    pin: str = Field(min_length=4, max_length=10, pattern=r"^\d{4,10}$")
    display_name: str = Field(min_length=1, max_length=120)
    role: Role


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    role: Role | None = None
    pin: str | None = Field(default=None, min_length=4, max_length=10, pattern=r"^\d{4,10}$")
    is_active: bool | None = None
