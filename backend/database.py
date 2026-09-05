import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise ValueError("DATABASE_URL environment variable is not set in .env")

# Ensure the scheme starts with postgresql:// (SQLAlchemy standard)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# create_engine with connection pooling & ping check
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,       # Auto-reconnects dropped connections
    pool_recycle=300          # Recycles connection every 5 minutes
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    """Dependency helper for FastAPI endpoints or scripts."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()