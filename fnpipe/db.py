from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from . import config
from .models import Base

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(config.DATABASE_URL, future=True)
    return _engine


def init_db():
    Base.metadata.create_all(get_engine())


def make_session() -> Session:
    return sessionmaker(bind=get_engine(), future=True)()
