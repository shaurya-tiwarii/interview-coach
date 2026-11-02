"""AI Mock Interview Coach - FastAPI backend.

Serves the API under /api/* and the static frontend at /.
Run locally:  uvicorn backend.app:app --port 8010
"""
import logging
import os
import sqlite3
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.staticfiles import StaticFiles

from . import analytics, auth, db
from .auth import get_current_user
from .evaluator import evaluate
from .questions import QuestionBank
from .schemas import (
    AnswerResponse, ChangePasswordRequest, CreateSessionRequest, CreateSessionResponse,
    FillerStats, LoginRequest, QuestionOut, RegisterRequest, ReportResponse, ScoresOut,
    SessionSummary, TurnReport, UpdateProfileRequest, UserOut, UserStats,
)
from .stt import transcribe

log = logging.getLogger("interview_coach")
logging.basicConfig(level=logging.INFO)

TOTAL_TURNS = int(os.environ.get("TOTAL_TURNS", "5"))
AUDIO_DIR = os.path.join(os.path.dirname(__file__), "data", "audio")

_banks: dict[str, QuestionBank] = {}


def get_bank(role: str) -> QuestionBank:
    if role not in _banks:
        _banks[role] = QuestionBank(role)
    return _banks[role]


def _qout(q: dict) -> QuestionOut:
    return QuestionOut(id=q["id"], text=q["text"],
                       dimension=q["dimension"], difficulty=q["difficulty"])


def _user_out(u) -> UserOut:
    return UserOut(id=u["id"], name=u["name"], email=u["email"], created_at=u["created_at"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="AI Mock Interview Coach", lifespan=lifespan)


# ---------------- auth ----------------

@app.post("/api/auth/register", response_model=UserOut, status_code=201)
def register(req: RegisterRequest, response: Response):
    if db.get_user_by_email(req.email):
        raise HTTPException(409, "an account with this email already exists")
    try:
        uid = db.create_user(req.name.strip(), req.email.strip(), auth.hash_password(req.password))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "an account with this email already exists")
    user = db.get_user(uid)
    auth.issue_session(response, uid)
    return _user_out(user)


@app.post("/api/auth/login", response_model=UserOut)
def login(req: LoginRequest, response: Response):
    user = db.get_user_by_email(req.email)
    if not user or not auth.verify_password(req.password, user["password_hash"]):
        raise HTTPException(401, "invalid email or password")
    auth.issue_session(response, user["id"])
    return _user_out(user)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    auth.clear_session(response, request)
    return {"ok": True}


@app.get("/api/auth/me", response_model=UserOut)
def me(user: dict = Depends(get_current_user)):
    return _user_out(user)


@app.patch("/api/auth/me", response_model=UserOut)
def update_profile(req: UpdateProfileRequest, user: dict = Depends(get_current_user)):
    db.update_user_name(user["id"], req.name.strip())
    return _user_out(db.get_user(user["id"]))


@app.post("/api/auth/password")
def change_password(req: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    fresh = db.get_user(user["id"])
    if not auth.verify_password(req.current_password, fresh["password_hash"]):
        raise HTTPException(400, "current password is incorrect")
    db.set_user_password(user["id"], auth.hash_password(req.new_password))
    return {"ok": True}


@app.delete("/api/auth/account")
def delete_account(request: Request, response: Response, user: dict = Depends(get_current_user)):
    db.delete_user_everything(user["id"])
    auth.clear_session(response, request)
    return {"ok": True}


@app.get("/api/stats", response_model=UserStats)
def stats(user: dict = Depends(get_current_user)):
    return UserStats(**db.user_stats(user["id"]))


# ---------------- interview sessions (per-user) ----------------

@app.get("/api/domains")
def domains(user: dict = Depends(get_current_user)):
    """Question dimensions (domains) available per role, from the banks."""
    return {role: get_bank(role).dimensions for role in
            ("software_engineer", "data_analyst", "hr_general",
             "devops_engineer", "cybersecurity_analyst", "qa_engineer")}


@app.post("/api/sessions", response_model=CreateSessionResponse)
def create_session(req: CreateSessionRequest, user: dict = Depends(get_current_user)):
    bank = get_bank(req.role)
    if req.domain and req.domain not in bank.dimensions:
        raise HTTPException(400, "unknown domain for this role")
    sid = db.create_session(req.role, req.difficulty, user["id"],
                            req.domain, req.company.strip(), req.experience)
    q = bank.first_question(req.difficulty, req.domain or None)
    return CreateSessionResponse(
        session_id=sid, turn=1, total_turns=TOTAL_TURNS, question=_qout(q))


@app.post("/api/sessions/{sid}/answer", response_model=AnswerResponse)
async def submit_answer(sid: str, audio: UploadFile | None = File(default=None),
                        text: str | None = Form(default=None),
                        writing_sec: float | None = Form(default=None),
                        user: dict = Depends(get_current_user)):
    """One answer, spoken or written. Exactly one of audio / text is required.

    Spoken: the upload is transcribed with faster-whisper; duration is the
    recording length. Written: the typed text is the transcript verbatim;
    duration is the time the candidate spent writing (sent by the frontend),
    so WPM is a writing pace and the turn is stored as answer_mode="written".
    Both paths share filler stats, Gemini rubric scoring and the
    retrieval-based next question.
    """
    sess = db.get_user_session(sid, user["id"])
    if not sess:
        raise HTTPException(404, "session not found")
    if sess["status"] != "active":
        raise HTTPException(400, "session is already complete")

    has_audio = audio is not None and bool(audio.filename)
    typed = (text or "").strip()
    if has_audio and typed:
        raise HTTPException(400, "send either a recording or written text, not both")
    if not has_audio and not typed:
        raise HTTPException(400, "no answer received: record or write an answer first")

    turns = db.get_turns(sid)
    n = len(turns) + 1
    bank = get_bank(sess["role"])
    domain = sess["domain"] or None
    qids = [t["question_id"] for t in turns]
    if n == 1:
        question = bank.first_question(sess["difficulty"], domain)
    else:
        # Re-derive the question the previous response served as next_question:
        # retrieval is deterministic in (transcript, asked_ids, difficulty).
        question = bank.next_question(turns[-1]["transcript"], qids, sess["difficulty"], domain)
        if question is None:
            raise HTTPException(400, "question bank exhausted")

    answer_mode = "spoken"
    audio_path = ""
    if typed:
        answer_mode = "written"
        transcript = typed[:5000]
        duration = min(max(writing_sec or 0.0, 0.0), 3600.0)
    else:
        # persist the upload
        os.makedirs(os.path.join(AUDIO_DIR, sid), exist_ok=True)
        ext = os.path.splitext(audio.filename or "")[1].lower() or ".wav"
        audio_path = os.path.join(AUDIO_DIR, sid, f"turn{n}{ext}")
        with open(audio_path, "wb") as f:
            f.write(await audio.read())

        # AI half: speech-to-text, then local DS metrics
        try:
            transcript, duration = transcribe(audio_path)
        except Exception as e:
            log.exception("transcription failed")
            raise HTTPException(500, f"transcription failed: {type(e).__name__}")

    wpm = analytics.compute_wpm(transcript, duration)
    filler = analytics.filler_word_stats(transcript)

    # AI half: LLM rubric scoring (graceful when no key / empty transcript)
    scores, feedback, llm_status = evaluate(question, transcript)

    db.add_turn(sid, n, question, transcript, audio_path, duration, wpm,
                filler["count"], filler["rate_per_100w"], scores, feedback, llm_status,
                answer_mode)

    complete = n >= TOTAL_TURNS
    next_q = None
    if not complete:
        nxt = bank.next_question(transcript, qids + [question["id"]], sess["difficulty"], domain)
        next_q = _qout(nxt) if nxt else None
        if next_q is None:
            complete = True
    if complete:
        db.set_session_status(sid, "complete")

    return AnswerResponse(
        turn=n, transcript=transcript, answer_mode=answer_mode,
        duration_sec=duration, wpm=wpm,
        filler=FillerStats(**filler),
        scores=ScoresOut(**scores) if scores else None,
        feedback=feedback, llm_status=llm_status,
        session_complete=complete, next_question=next_q)


@app.get("/api/sessions/{sid}/report", response_model=ReportResponse)
def session_report(sid: str, user: dict = Depends(get_current_user)):
    sess = db.get_user_session(sid, user["id"])
    if not sess:
        raise HTTPException(404, "session not found")
    turns = db.get_turns(sid)
    turn_reports = [
        TurnReport(
            n=t["n"], question=t["question"], question_id=t["question_id"],
            dimension=t["dimension"], difficulty=t["difficulty"],
            transcript=t["transcript"], answer_mode=t.get("answer_mode") or "spoken",
            duration_sec=t["duration_sec"], wpm=t["wpm"],
            filler_count=t["filler_count"], filler_rate=t["filler_rate"],
            scores=(ScoresOut(content_relevance=t["score_content"],
                              clarity_structure=t["score_clarity"],
                              confidence=t["score_confidence"])
                    if t["score_content"] is not None else None),
            feedback=t["feedback"], llm_status=t["llm_status"],
        )
        for t in turns
    ]
    return ReportResponse(
        session_id=sid, role=sess["role"], difficulty=sess["difficulty"],
        domain=sess["domain"] or "", company=sess["company"] or "",
        experience=sess["experience"] or "",
        status=sess["status"], created_at=sess["created_at"],
        total_turns=TOTAL_TURNS, turns=turn_reports,
        averages=analytics.dimension_breakdown(turns),
        trends=analytics.score_trends(turns))


@app.get("/api/sessions", response_model=list[SessionSummary])
def session_history(user: dict = Depends(get_current_user)):
    return [
        SessionSummary(
            session_id=s["id"], role=s["role"], difficulty=s["difficulty"],
            domain=s.get("domain") or "", company=s.get("company") or "",
            experience=s.get("experience") or "",
            status=s["status"], created_at=s["created_at"],
            turns_answered=s["turns_answered"],
            avg_overall=(round(s["avg_overall"], 2) if s["avg_overall"] is not None else None),
        )
        for s in db.list_sessions(user["id"])
    ]


@app.get("/api/health")
def health():
    return {"ok": True}


# Frontend (must be mounted last so /api/* takes precedence)
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
