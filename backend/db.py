"""SQLite storage for sessions and turns. Plain sqlite3, no ORM."""
import os
import sqlite3
import uuid
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "INTERVIEW_COACH_DB",
    os.path.join(os.path.dirname(__file__), "data", "interview_coach.db"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    n INTEGER NOT NULL,
    question TEXT NOT NULL,
    question_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    transcript TEXT NOT NULL DEFAULT '',
    audio_path TEXT DEFAULT '',
    duration_sec REAL NOT NULL DEFAULT 0,
    wpm REAL NOT NULL DEFAULT 0,
    filler_count INTEGER NOT NULL DEFAULT 0,
    filler_rate REAL NOT NULL DEFAULT 0,
    score_content REAL,
    score_clarity REAL,
    score_confidence REAL,
    feedback TEXT DEFAULT '',
    llm_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    UNIQUE(session_id, n)
);
"""


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(SCHEMA)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_session(role: str, difficulty: str) -> str:
    sid = uuid.uuid4().hex[:12]
    with _connect() as conn:
        conn.execute(
            "INSERT INTO sessions (id, role, difficulty, status, created_at) VALUES (?, ?, ?, 'active', ?)",
            (sid, role, difficulty, _now()),
        )
    return sid


def get_session(sid: str):
    with _connect() as conn:
        return conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()


def set_session_status(sid: str, status: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE sessions SET status = ? WHERE id = ?", (status, sid))


def add_turn(sid: str, n: int, question: dict, transcript: str, audio_path: str,
             duration_sec: float, wpm: float, filler_count: int, filler_rate: float,
             scores: dict | None, feedback: str, llm_status: str) -> int:
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO turns
               (session_id, n, question, question_id, dimension, difficulty,
                transcript, audio_path, duration_sec, wpm, filler_count, filler_rate,
                score_content, score_clarity, score_confidence, feedback, llm_status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sid, n, question["text"], question["id"], question["dimension"], question["difficulty"],
             transcript, audio_path, duration_sec, wpm, filler_count, filler_rate,
             (scores or {}).get("content_relevance"), (scores or {}).get("clarity_structure"),
             (scores or {}).get("confidence"), feedback, llm_status, _now()),
        )
        return cur.lastrowid


def get_turns(sid: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY n", (sid,)
        ).fetchall()
    return [dict(r) for r in rows]


def asked_question_ids(sid: str) -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT question_id FROM turns WHERE session_id = ?", (sid,)
        ).fetchall()
    return [r["question_id"] for r in rows]


def list_sessions() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT s.*, COUNT(t.id) AS turns_answered,
                      AVG((t.score_content + t.score_clarity + t.score_confidence) / 3.0) AS avg_overall
               FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
               GROUP BY s.id ORDER BY s.created_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]
