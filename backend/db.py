"""SQLite storage for users, auth sessions, interview sessions and turns.
Plain sqlite3, no ORM."""
import os
import sqlite3
import uuid
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "INTERVIEW_COACH_DB",
    os.path.join(os.path.dirname(__file__), "data", "interview_coach.db"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    user_id TEXT REFERENCES users(id),
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
CREATE INDEX IF NOT EXISTS idx_auth_user ON auth_sessions(user_id);
"""


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive migrations for databases created before a schema change."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if "user_id" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)")
    # Safe to run on both fresh and migrated databases (IF NOT EXISTS).
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------- users ----------------

def create_user(name: str, email: str, password_hash: str) -> str:
    uid = uuid.uuid4().hex[:12]
    with _connect() as conn:
        conn.execute(
            "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            (uid, name, email.lower(), password_hash, _now()),
        )
    return uid


def get_user_by_email(email: str):
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()


def get_user(uid: str):
    with _connect() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()


def update_user_name(uid: str, name: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, uid))


def set_user_password(uid: str, password_hash: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, uid))


# ---------------- auth sessions ----------------

def create_auth_session(token: str, user_id: str, expires_at: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, _now(), expires_at),
        )


def get_auth_session(token: str):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM auth_sessions WHERE token = ?", (token,)).fetchone()
    if not row:
        return None
    if row["expires_at"] < _now():
        delete_auth_session(token)
        return None
    return row


def delete_auth_session(token: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE token = ?", (token,))


def delete_user_auth_sessions(user_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))


def delete_user_everything(user_id: str) -> None:
    """Delete a user, all of their interview data, auth sessions, and the
    audio files stored on disk for their sessions."""
    import shutil
    audio_root = os.path.join(os.path.dirname(__file__), "data", "audio")
    with _connect() as conn:
        sids = [r["id"] for r in
                conn.execute("SELECT id FROM sessions WHERE user_id = ?", (user_id,)).fetchall()]
        for sid in sids:
            conn.execute("DELETE FROM turns WHERE session_id = ?", (sid,))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    # Remove the on-disk audio after the DB rows are gone. Never let a
    # filesystem error leave the account half-deleted: best-effort cleanup.
    for sid in sids:
        shutil.rmtree(os.path.join(audio_root, sid), ignore_errors=True)


# ---------------- interview sessions ----------------

def create_session(role: str, difficulty: str, user_id: str | None = None) -> str:
    sid = uuid.uuid4().hex[:12]
    with _connect() as conn:
        conn.execute(
            "INSERT INTO sessions (id, role, difficulty, status, user_id, created_at) VALUES (?, ?, ?, 'active', ?, ?)",
            (sid, role, difficulty, user_id, _now()),
        )
    return sid


def get_session(sid: str):
    with _connect() as conn:
        return conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()


def get_user_session(sid: str, user_id: str):
    with _connect() as conn:
        return conn.execute(
            "SELECT * FROM sessions WHERE id = ? AND user_id = ?", (sid, user_id)).fetchone()


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


def list_sessions(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT s.*, COUNT(t.id) AS turns_answered,
                      AVG((t.score_content + t.score_clarity + t.score_confidence) / 3.0) AS avg_overall
               FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
               WHERE s.user_id = ?
               GROUP BY s.id ORDER BY s.created_at DESC""",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def user_stats(user_id: str) -> dict:
    with _connect() as conn:
        row = conn.execute(
            """SELECT COUNT(DISTINCT s.id) AS sessions_total,
                      COUNT(DISTINCT CASE WHEN s.status = 'complete' THEN s.id END) AS sessions_completed,
                      COUNT(t.id) AS answers_total,
                      AVG((t.score_content + t.score_clarity + t.score_confidence) / 3.0) AS avg_overall,
                      AVG(t.wpm) AS avg_wpm,
                      SUM(t.duration_sec) AS total_seconds
               FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
               WHERE s.user_id = ?""",
            (user_id,),
        ).fetchone()
    d = dict(row)
    return {
        "sessions_total": d["sessions_total"] or 0,
        "sessions_completed": d["sessions_completed"] or 0,
        "answers_total": d["answers_total"] or 0,
        "avg_overall": round(d["avg_overall"], 2) if d["avg_overall"] is not None else None,
        "avg_wpm": round(d["avg_wpm"]) if d["avg_wpm"] is not None else None,
        "total_minutes": round((d["total_seconds"] or 0) / 60, 1),
    }
