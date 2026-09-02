from database import engine
from sqlalchemy import text

def test_connection():
    try:
        with engine.connect() as connection:
            result = connection.execute(text("SELECT version();"))
            row = result.fetchone()
            print("[SUCCESS] Connected to PostgreSQL Database!")
            print(f"[DB VERSION] {row[0]}")
    except Exception as e:
        print(f"[FAILED] Database connection error: {e}")

if __name__ == "__main__":
    test_connection()