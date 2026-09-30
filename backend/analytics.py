"""Data-science layer: pure functions that turn raw transcripts and scores into
interview-performance metrics. No I/O, no model calls, so this module is the
explicit DS half of the project for the review panel."""
import re

# Filler words/phrases counted by filler_word_stats(). Multi-word fillers are
# matched as whole phrases; single words are matched as whole tokens.
FILLERS = [
    "um", "uh", "erm", "ah", "hmm",
    "like", "basically", "actually", "literally",
    "you know", "i mean", "sort of", "kind of",
]

_WORD_RE = re.compile(r"[a-z0-9']+")


def _tokens(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower())


def compute_wpm(transcript: str, duration_sec: float) -> float:
    """Words per minute of the spoken answer. Returns 0.0 for empty input."""
    words = len(_tokens(transcript))
    if words == 0 or duration_sec <= 0:
        return 0.0
    return round(words / duration_sec * 60.0, 1)


def filler_word_stats(transcript: str) -> dict:
    """Count filler words/phrases in a transcript.

    Returns {"count": int, "rate_per_100w": float, "words": {filler: count}}.
    rate_per_100w is filler occurrences per 100 spoken words.
    """
    text = transcript.lower()
    tokens = _tokens(transcript)
    per_filler: dict[str, int] = {}
    for filler in FILLERS:
        if " " in filler:
            # phrase: count non-overlapping occurrences via regex on word boundaries
            pattern = r"\b" + r"\s+".join(map(re.escape, filler.split())) + r"\b"
            c = len(re.findall(pattern, text))
        else:
            c = sum(1 for t in tokens if t == filler)
        if c:
            per_filler[filler] = c
    count = sum(per_filler.values())
    rate = round(count / max(len(tokens), 1) * 100.0, 1)
    return {"count": count, "rate_per_100w": rate, "words": per_filler}


def _overall(turn: dict) -> float | None:
    vals = [turn.get("score_content"), turn.get("score_clarity"), turn.get("score_confidence")]
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    return round(sum(vals) / len(vals), 2)


def score_trends(turns: list[dict]) -> dict:
    """Per-turn time series for the dashboard charts.

    Returns {"wpm": [...], "filler_rate": [...], "overall_score": [...]}
    where overall_score entries may be None when the LLM was unavailable.
    """
    return {
        "wpm": [t.get("wpm", 0.0) for t in turns],
        "filler_rate": [t.get("filler_rate", 0.0) for t in turns],
        "overall_score": [_overall(t) for t in turns],
    }


def dimension_breakdown(turns: list[dict]) -> dict:
    """Average score per rubric dimension across answered turns.

    Returns {"content_relevance": avg|None, "clarity_structure": ..., "confidence": ..., "overall": ...}.
    A dimension is None when no turn has a score for it (e.g. LLM not configured).
    """
    out: dict[str, float | None] = {}
    for key, col in (("content_relevance", "score_content"),
                     ("clarity_structure", "score_clarity"),
                     ("confidence", "score_confidence")):
        vals = [t[col] for t in turns if t.get(col) is not None]
        out[key] = round(sum(vals) / len(vals), 2) if vals else None
    overalls = [_overall(t) for t in turns]
    overalls = [o for o in overalls if o is not None]
    out["overall"] = round(sum(overalls) / len(overalls), 2) if overalls else None
    return out
