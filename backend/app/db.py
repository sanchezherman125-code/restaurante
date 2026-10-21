from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(settings.active_database_url, pool_pre_ping=True, hide_parameters=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)


@event.listens_for(Session, "after_commit")
def publish_committed_events(db: Session) -> None:
    from app.ws.hub import hub

    for name, payload, channels in db.info.pop("events", []):
        hub.broadcast(name, payload, channels)


@event.listens_for(Session, "after_rollback")
def discard_rolled_back_events(db: Session) -> None:
    db.info.pop("events", None)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
