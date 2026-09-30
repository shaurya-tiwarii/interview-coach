# AI Mock Interview Coach - Architecture

## Module diagram

```mermaid
flowchart LR
    subgraph Frontend ["Frontend (static SPA)"]
        UI["index.html + app.js<br/>setup · interview · feedback · dashboard"]
    end
    subgraph Backend ["Backend (FastAPI)"]
        API["app.py<br/>/api/sessions, /answer, /report"]
        DB[("db.py<br/>SQLite: sessions, turns")]
        QB["questions.py<br/>JSON bank + ChromaDB"]
        STT["stt.py<br/>faster-whisper (local)"]
        EV["evaluator.py<br/>Gemini rubric scoring"]
        AN["analytics.py<br/>WPM · fillers · trends"]
    end
    UI -->|POST /api/sessions| API
    UI -->|POST multipart audio| API
    API --> DB
    API --> QB
    API --> STT
    API --> EV
    API --> AN
```

## Data flow for one answer turn

```mermaid
sequenceDiagram
    participant U as Candidate (browser)
    participant A as FastAPI (app.py)
    participant S as faster-whisper (stt.py)
    participant M as analytics.py
    participant G as Gemini (evaluator.py)
    participant V as ChromaDB (questions.py)
    participant D as SQLite (db.py)

    U->>A: POST /api/sessions/{id}/answer (audio)
    A->>A: save audio to data/audio/
    A->>S: transcribe(audio_path)
    S-->>A: transcript, duration_sec
    A->>M: compute_wpm, filler_word_stats
    M-->>A: wpm, filler counts/rate
    alt GEMINI_API_KEY set and transcript non-empty
        A->>G: rubric prompt (question + transcript)
        G-->>A: 3 scores (0-10) + feedback
    else
        A-->>A: scores=None, llm_status=llm_not_configured
    end
    A->>V: query(transcript, exclude=asked_ids)
    V-->>A: next question (semantic match)
    A->>D: store turn (all of the above)
    A-->>U: transcript, metrics, scores, feedback, next question
```

## Key design decisions
- **Local-first STT**: raw audio never leaves the machine; faster-whisper `base`
  runs on CPU (override with `WHISPER_MODEL`). Only the text transcript is sent
  to Gemini, and only when `GEMINI_API_KEY` is set. (`stt.py` decodes audio via
  PyAV itself and passes a waveform to faster-whisper, because the pinned
  faster-whisper 1.2.1 passes a `metadata_errors` keyword that the pinned
  PyAV 19.0.0 removed.)
- **Graceful LLM degradation**: every turn is fully usable without a Gemini key.
  Transcript + local metrics are always computed; the API reports
  `llm_not_configured` honestly instead of failing.
- **Deterministic question flow**: the first question is the first bank entry
  matching the difficulty; follow-ups re-derive deterministically from
  (previous transcript, asked ids, difficulty), so backend and frontend agree
  on the current question without extra state.
- **Pure-function DS layer**: `analytics.py` has no I/O, so it is trivially testable
  and easy to demo to a review panel.
- **SQLite**: zero-setup persistence; the DB file lives in `backend/data/`.
