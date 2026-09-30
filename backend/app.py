"""AI Mock Interview Coach - FastAPI backend.

Serves the API under /api/* and the static frontend at /.
Run locally:  uvicorn backend.app:app --port 8010
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles

from . import analytics, db
from .evaluator import evaluate
from .questions import QuestionBank
from .schemas import (
    AnswerResponse, CreateSessionRequest, CreateSessionResponse,
    FillerStats, QuestionOut, ReportResponse, ScoresOut,
    SessionSummary, TurnReport,
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="AI Mock Interview Coach", lifespan=lifespan)


@app.post("/api/sessions", response_model=CreateSessionResponse)
def create_session(req: CreateSessionRequest):
    bank = get_bank(req.role)
    sid = db.create_session(req.role, req.difficulty)
    q = bank.first_question(req.difficulty)
    return CreateSessionResponse(
        session_id=sid, turn=1, total_turns=TOTAL_TURNS, question=_qout(q))


@app.post("/api/sessions/{sid}/answer", response_model=AnswerResponse)
async def submit_answer(sid: str, audio: UploadFile = File(...)):
    sess = db.get_session(sid)
    if not sess:
        raise HTTPException(404, "session not found")
    if sess["status"] != "active":
        raise HTTPException(400, "session is already complete")

    turns = db.get_turns(sid)
    n = len(turns) + 1
    bank = get_bank(sess["role"])
    qids = [t["question_id"] for t in turns]
    if n == 1:
        question = bank.first_question(sess["difficulty"])
    else:
        # Re-derive the question the previous response served as next_question:
        # retrieval is deterministic in (transcript, asked_ids, difficulty).
        question = bank.next_question(turns[-1]["transcript"], qids, sess["difficulty"])
        if question is None:
            raise HTTPException(400, "question bank exhausted")

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
                filler["count"], filler["rate_per_100w"], scores, feedback, llm_status)

    complete = n >= TOTAL_TURNS
    next_q = None
    if not complete:
        nxt = bank.next_question(transcript, qids + [question["id"]], sess["difficulty"])
        next_q = _qout(nxt) if nxt else None
        if next_q is None:
            complete = True
    if complete:
        db.set_session_status(sid, "complete")

    return AnswerResponse(
        turn=n, transcript=transcript, duration_sec=duration, wpm=wpm,
        filler=FillerStats(**filler),
        scores=ScoresOut(**scores) if scores else None,
        feedback=feedback, llm_status=llm_status,
        session_complete=complete, next_question=next_q)


@app.get("/api/sessions/{sid}/report", response_model=ReportResponse)
def session_report(sid: str):
    sess = db.get_session(sid)
    if not sess:
        raise HTTPException(404, "session not found")
    turns = db.get_turns(sid)
    turn_reports = [
        TurnReport(
            n=t["n"], question=t["question"], question_id=t["question_id"],
            dimension=t["dimension"], difficulty=t["difficulty"],
            transcript=t["transcript"], duration_sec=t["duration_sec"], wpm=t["wpm"],
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
        status=sess["status"], created_at=sess["created_at"],
        total_turns=TOTAL_TURNS, turns=turn_reports,
        averages=analytics.dimension_breakdown(turns),
        trends=analytics.score_trends(turns))


@app.get("/api/sessions", response_model=list[SessionSummary])
def session_history():
    return [
        SessionSummary(
            session_id=s["id"], role=s["role"], difficulty=s["difficulty"],
            status=s["status"], created_at=s["created_at"],
            turns_answered=s["turns_answered"],
            avg_overall=(round(s["avg_overall"], 2) if s["avg_overall"] is not None else None),
        )
        for s in db.list_sessions()
    ]


@app.get("/api/health")
def health():
    return {"ok": True}


# Frontend (must be mounted last so /api/* takes precedence)
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
