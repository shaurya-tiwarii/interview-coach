"""Question bank + ChromaDB retrieval for the RAG follow-up loop.

On session start, the role's questions are embedded into a persistent ChromaDB
collection. After each answer, the next question is retrieved by semantic
similarity to the candidate's answer transcript (excluding already-asked
questions), a simple retrieval-grounded question-selection loop.

If ChromaDB/embedding is unavailable, selection falls back to plain
difficulty-filtered cycling so the app still works. The fallback is reported
via QuestionBank.retrieval_mode ("vector" | "fallback").
"""
import json
import logging
import os

# Silence ChromaDB's anonymous telemetry (no network calls from the DB layer).
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

log = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
CHROMA_DIR = os.path.join(DATA_DIR, "chroma")
ROLE_FILES = {
    "software_engineer": "questions_software_engineer.json",
    "data_analyst": "questions_data_analyst.json",
    "hr_general": "questions_hr_general.json",
    "devops_engineer": "questions_devops_engineer.json",
    "cybersecurity_analyst": "questions_cybersecurity_analyst.json",
    "qa_engineer": "questions_qa_engineer.json",
}

# Valid difficulty tags in the bank files.
DIFFICULTIES = ("easy", "medium", "hard")


def load_bank(role: str) -> list[dict]:
    path = os.path.join(DATA_DIR, ROLE_FILES[role])
    with open(path, encoding="utf-8") as f:
        return json.load(f)["questions"]


def _get_collection(role: str):
    """Return (client, collection) for the role, building it on first use."""
    import chromadb

    os.makedirs(CHROMA_DIR, exist_ok=True)
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    # v2: rebuilt when the banks grew (2026-11-02: 54 to 96 questions,
    # new domains). Bump again whenever questions are added or edited,
    # or the vector path will keep serving the old bank.
    name = f"questions_{role}_v2"
    try:
        return client, client.get_collection(name)
    except Exception:
        pass
    questions = load_bank(role)
    collection = client.create_collection(name)
    collection.add(
        ids=[q["id"] for q in questions],
        documents=[q["text"] for q in questions],
        metadatas=[{"difficulty": q["difficulty"], "dimension": q["dimension"]}
                   for q in questions],
    )
    return client, collection


class QuestionBank:
    """Per-role question selector with vector-retrieval follow-ups."""

    def __init__(self, role: str):
        self.role = role
        self.questions = load_bank(role)
        self.by_id = {q["id"]: q for q in self.questions}
        self.retrieval_mode = "fallback"
        self._collection = None
        try:
            _, self._collection = _get_collection(role)
            self.retrieval_mode = "vector"
        except Exception as e:  # embedding model download failed etc.
            log.warning("ChromaDB unavailable, using fallback selection: %s", e)

    def _matches_difficulty(self, q: dict, difficulty: str) -> bool:
        return difficulty == "mixed" or q["difficulty"] == difficulty

    def _matches_dimension(self, q: dict, dimension: str | None) -> bool:
        return not dimension or q["dimension"] == dimension

    @property
    def dimensions(self) -> list[str]:
        """Distinct question dimensions (domains) in this role's bank."""
        return sorted({q["dimension"] for q in self.questions})

    def first_question(self, difficulty: str, dimension: str | None = None) -> dict:
        """Deterministic opener: first bank question matching the filters.

        Tiered relaxation so a narrow domain never leaves a session without
        an opener: dimension+difficulty, then dimension, then difficulty,
        then the first bank question.
        """
        tiers = [
            lambda q: self._matches_dimension(q, dimension) and self._matches_difficulty(q, difficulty),
            lambda q: self._matches_dimension(q, dimension),
            lambda q: self._matches_difficulty(q, difficulty),
        ]
        for match in tiers:
            for q in self.questions:
                if match(q):
                    return q
        return self.questions[0]

    def next_question(self, transcript: str, asked_ids: list[str], difficulty: str,
                      dimension: str | None = None) -> dict | None:
        """Pick the next question semantically related to the last answer.

        Candidates are ordered in tiers: dimension+difficulty, dimension,
        difficulty, then any unasked question, so a focused session stays
        in its domain while the bank has questions, then relaxes instead
        of ending early. Vector path: query the collection with the
        transcript, take the best hit present in the ordered candidates.
        Fallback path: first candidate. Returns None when the bank is
        exhausted.
        """
        def tiered(pool: list[dict]) -> list[list[dict]]:
            tiers, seen = [], set()
            for match in (
                lambda q: self._matches_dimension(q, dimension) and self._matches_difficulty(q, difficulty),
                lambda q: self._matches_dimension(q, dimension),
                lambda q: self._matches_difficulty(q, difficulty),
                lambda q: True,
            ):
                tier = [q for q in pool if q["id"] not in seen and match(q)]
                seen.update(q["id"] for q in tier)
                tiers.append(tier)
            return tiers

        tiers = tiered([q for q in self.questions if q["id"] not in asked_ids])
        candidates = [q for tier in tiers for q in tier]
        if not candidates:
            return None

        if self._collection is not None and transcript.strip():
            try:
                res = self._collection.query(
                    query_texts=[transcript[:2000]],
                    # Rank the whole collection: with a small top-k, the
                    # remaining questions in a focused domain may not appear
                    # in the results at all, and focus would leak to other
                    # domains even though bank questions remain.
                    n_results=self._collection.count(),
                )
                # Domain focus wins over semantic similarity: take the best
                # vector hit inside the narrowest non-empty tier, so a
                # focused session stays in its domain while questions remain.
                for tier in tiers:
                    for qid in res["ids"][0]:
                        hit = next((q for q in tier if q["id"] == qid), None)
                        if hit:
                            return hit
            except Exception as e:
                log.warning("vector query failed, using fallback: %s", e)
        return candidates[0]
