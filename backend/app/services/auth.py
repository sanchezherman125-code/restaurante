from app.core.security import create_access_token, create_refresh_token
from app.models import User
from app.schemas.auth import TokenResponse


def issue_tokens(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(str(user.id), user.role, user.username),
        refresh_token=create_refresh_token(str(user.id), user.role, user.username),
    )
