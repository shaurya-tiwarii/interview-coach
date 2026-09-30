"""Answer evaluation with Google Gemini.

The API key is read ONLY from the GEMINI_API_KEY environment variable and is
never hardcoded or logged. When the key is unset, evaluation is skipped and
the caller receives llm_status="llm_not_configured" with scores=None, while the
transcript and local DS metrics are still returned.
"""
import json
import logging
import os
import re

log = logging.getLogger(__name__)

MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

PROMPT = """You are an interview coach scoring a candidate's spoken answer.
Question ({dimension}, difficulty {difficulty}):
{question}

Candidate's transcribed answer:
{transcript}

Score three dimensions from 0 to 10 (one decimal allowed):
- content_relevance: does the answer address the question with correct, substantive points?
- clarity_structure: is the answer organized and easy to follow?
- confidence: does the candidate sound sure, specific, and decisive (from word choice, not audio)?

Also write 2-4 sentences of constructive feedback: one specific strength and one concrete improvement.

Reply with ONLY valid JSON, no markdown fences, in exactly this shape:
{{"content_relevance": 7.5, "clarity_structure": 8.0, "confidence": 6.5, "feedback": "..."}}
"""


def _parse_json(raw: str) -> dict | None:
    raw = raw.strip()
    # tolerate markdown fences if the model adds them despite instructions
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    try:
        return {
            "content_relevance": float(data["content_relevance"]),
            "clarity_structure": float(data["clarity_structure"]),
            "confidence": float(data["confidence"]),
            "feedback": str(data["feedback"]),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _clamp(v: float) -> float:
    return round(max(0.0, min(10.0, v)), 1)


def evaluate(question: dict, transcript: str) -> tuple[dict | None, str, str]:
    """Evaluate one answer. Returns (scores_dict|None, feedback, llm_status).

    llm_status is one of: "ok" | "llm_not_configured" | "empty_transcript" | "llm_error".
    """
    if not transcript.strip():
        return None, "No speech was transcribed from the recording, so there is nothing to evaluate.", "empty_transcript"

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None, (
            "LLM evaluation skipped: GEMINI_API_KEY is not set. "
            "Transcript and local metrics (WPM, filler words) were still computed."
        ), "llm_not_configured"

    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(MODEL_NAME)
        resp = model.generate_content(PROMPT.format(
            dimension=question["dimension"],
            difficulty=question["difficulty"],
            question=question["text"],
            transcript=transcript[:4000],
        ))
        parsed = _parse_json(resp.text or "")
        if not parsed:
            raise ValueError("could not parse model JSON")
        scores = {k: _clamp(parsed[k]) for k in
                  ("content_relevance", "clarity_structure", "confidence")}
        return scores, parsed["feedback"], "ok"
    except Exception as e:
        log.warning("Gemini evaluation failed: %s", e)
        return None, f"LLM evaluation failed ({type(e).__name__}); transcript and local metrics were still computed.", "llm_error"
