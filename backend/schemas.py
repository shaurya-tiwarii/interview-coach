"""Pydantic request/response schemas for the interview coach API."""
from typing import Optional
from pydantic import BaseModel, Field


class CreateSessionRequest(BaseModel):
    role: str = Field(pattern=r"^(software_engineer|data_analyst|hr_general)$")
    difficulty: str = Field(default="mixed", pattern=r"^(easy|mixed|hard)$")


class QuestionOut(BaseModel):
    id: str
    text: str
    dimension: str
    difficulty: str


class CreateSessionResponse(BaseModel):
    session_id: str
    turn: int
    total_turns: int
    question: QuestionOut


class FillerStats(BaseModel):
    count: int
    rate_per_100w: float
    words: dict


class ScoresOut(BaseModel):
    content_relevance: Optional[float] = None
    clarity_structure: Optional[float] = None
    confidence: Optional[float] = None


class AnswerResponse(BaseModel):
    turn: int
    transcript: str
    duration_sec: float
    wpm: float
    filler: FillerStats
    scores: Optional[ScoresOut] = None
    feedback: Optional[str] = None
    llm_status: str
    session_complete: bool
    next_question: Optional[QuestionOut] = None


class TurnReport(BaseModel):
    n: int
    question: str
    question_id: str
    dimension: str
    difficulty: str
    transcript: str
    duration_sec: float
    wpm: float
    filler_count: int
    filler_rate: float
    scores: Optional[ScoresOut] = None
    feedback: Optional[str] = None
    llm_status: str


class ReportResponse(BaseModel):
    session_id: str
    role: str
    difficulty: str
    status: str
    created_at: str
    total_turns: int
    turns: list[TurnReport]
    averages: Optional[dict] = None
    trends: dict


class SessionSummary(BaseModel):
    session_id: str
    role: str
    difficulty: str
    status: str
    created_at: str
    turns_answered: int
    avg_overall: Optional[float] = None


# ---------------- auth ----------------

EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(pattern=EMAIL_RE, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(pattern=EMAIL_RE, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: str
    name: str
    email: str
    created_at: str


class UpdateProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UserStats(BaseModel):
    sessions_total: int
    sessions_completed: int
    answers_total: int
    avg_overall: Optional[float] = None
    avg_wpm: Optional[float] = None
    total_minutes: float
