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
    name = f"questions_{role}"
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

    def first_question(self, difficulty: str) -> dict:
        """Deterministic opener: first bank question matching the difficulty."""
        for q in self.questions:
            if self._matches_difficulty(q, difficulty):
                return q
        return self.questions[0]

    def next_question(self, transcript: str, asked_ids: list[str], difficulty: str) -> dict | None:
        """Pick the next question semantically related to the last answer.

        Vector path: query the collection with the transcript, take the best
        hit that hasn't been asked and matches the difficulty filter.
        Fallback path: first unasked question matching the difficulty filter.
        Returns None when the bank is exhausted.
        """
        candidates = [q for q in self.questions
                      if q["id"] not in asked_ids and self._matches_difficulty(q, difficulty)]
        if not candidates:
            # relax the difficulty filter before giving up
            candidates = [q for q in self.questions if q["id"] not in asked_ids]
        if not candidates:
            return None

        if self._collection is not None and transcript.strip():
            try:
                res = self._collection.query(
                    query_texts=[transcript[:2000]],
                    n_results=min(8, self._collection.count()),
                )
                for qid in res["ids"][0]:
                    hit = next((q for q in candidates if q["id"] == qid), None)
                    if hit:
                        return hit
            except Exception as e:
                log.warning("vector query failed, using fallback: %s", e)
        return candidates[0]
