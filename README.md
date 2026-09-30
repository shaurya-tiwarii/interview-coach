# AI Mock Interview Coach

A local web app for AI&DS mini-project review: conducts role-specific mock
interviews, transcribes spoken answers locally, scores them with an LLM judge,
computes speech analytics, and picks follow-up questions with vector retrieval.

## Setup

```bash
cd ~/workspace/interview-coach
python3 -m venv .venv
source .venv/bin/activate

# /tmp is a small tmpfs on this machine, so keep pip temp/cache in the workspace:
export TMPDIR=~/workspace/.pip-tmp
pip install --cache-dir ~/workspace/.pip-cache -r requirements.txt

# Optional: enable AI scoring (key is read ONLY from the environment)
export GEMINI_API_KEY="your-key-here"   # never commit a real key
```

First run downloads two models automatically (needs internet):
- faster-whisper `base` (~145 MB) for speech-to-text
- ChromaDB's default embedding model (~80 MB) for question retrieval
If a download is blocked, unset proxy vars first: `unset no_proxy NO_PROXY`.
If the models are already cached and you are offline, skip re-download checks:
`HF_HUB_OFFLINE=1 uvicorn backend.app:app --port 8010`.

## Run

```bash
source .venv/bin/activate
uvicorn backend.app:app --port 8010
# open http://localhost:8010
```

No key? The app still works: every answer returns a transcript plus local
metrics (WPM, filler words, duration) with `llm_status: "llm_not_configured"`.
Only the 0–10 rubric scores and AI feedback need the key.

## Windows (Python 3.10)

`requirements.txt` targets Python 3.12 (av 19.0.0 and numpy 2.5.3 need it).
On Python 3.10, use the 3.10 variant instead — same app, newest 3.10-compatible
pins:

```powershell
cd D:\interview-coach\interview-coach
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-py310.txt
$env:GEMINI_API_KEY="your-key-here"   # optional, for AI scoring
uvicorn backend.app:app --port 8010
# open http://localhost:8010
```

No PyTorch needed: faster-whisper runs on ctranslate2, so the install is a few
hundred MB, not gigabytes.

## API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/sessions` | `{role, difficulty}` → session + first question |
| POST | `/api/sessions/{id}/answer` | multipart `audio` → transcript, metrics, scores, feedback, next question |
| GET | `/api/sessions/{id}/report` | per-turn detail + dimension averages + trends |
| GET | `/api/sessions` | history list (role, date, avg score) |
| GET | `/api/health` | liveness check |

Roles: `software_engineer`, `data_analyst`, `hr_general`.
Difficulty: `easy`, `mixed`, `hard`. Sessions run 5 questions (`TOTAL_TURNS`).

### Try the API (review-day demo)

```bash
# 1. create a session
curl -s -X POST localhost:8010/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"role":"software_engineer","difficulty":"mixed"}'
# -> {"session_id":"...","turn":1,"total_turns":5,"question":{...}}

# 2. answer with an audio file (wav/mp3/webm)
SID=<session_id from step 1>
curl -s -X POST localhost:8010/api/sessions/$SID/answer \
  -F "audio=@/path/to/answer.wav" | python3 -m json.tool
# -> transcript, wpm, filler stats, scores (null + llm_not_configured without a key),
#    feedback, and the next question. Repeat for turns 2-5.

# 3. session report and history
curl -s localhost:8010/api/sessions/$SID/report | python3 -m json.tool
curl -s localhost:8010/api/sessions | python3 -m json.tool
```

To use a `.env` file: `set -a; source .env; set +a` before starting uvicorn.

## Project layout

```
backend/
  app.py          FastAPI routes + static frontend serving
  db.py           SQLite schema & helpers (backend/data/interview_coach.db)
  questions.py    curated JSON banks + ChromaDB RAG follow-up selection
  stt.py          faster-whisper transcription (lazy, local)
  evaluator.py    Gemini rubric scoring w/ no-key fallback
  analytics.py    DS layer: compute_wpm, filler_word_stats, score_trends, dimension_breakdown
  data/           question banks, sqlite db, chroma index, saved audio
frontend/         single-page app (GSAP + Chart.js via CDN)
docs/             synopsis.md, architecture.md
```

## Review-day tips
- Run through one full 5-question session beforehand so the dashboard has data.
- Keep a screen recording of a full session as backup. If the network flakes,
  the LLM scoring degrades gracefully but a recording removes all doubt.
- The `analytics.py` module is pure functions: easy to demo unit-style
  (`compute_wpm`, `filler_word_stats`) live in a Python REPL.
- If asked "what's the RAG part?": after each answer, the app embeds the
  transcript and retrieves the most relevant *unasked* question from the bank
  via ChromaDB. Retrieval grounds question selection in what you just said.
