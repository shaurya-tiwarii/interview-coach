# AI Mock Interview Coach - Project Synopsis

## 1. Problem statement
Students preparing for placements get almost no realistic interview practice.
Reading questions off a list does not train spoken delivery, and self-practice
gives no objective feedback on *how* an answer was delivered (pace, filler
words, structure) or on *what* was said. Existing tools are either generic
chatbots with no interview structure or paid platforms.

## 2. Proposed solution
A local web app that conducts role-specific mock interviews end to end:
the candidate speaks answers into the microphone, the app transcribes them
with a local speech model, scores each answer on three rubric dimensions with
an LLM judge, computes speech-analytics metrics locally, and picks the next
question by semantic retrieval over a curated question bank. A dashboard
tracks performance across sessions.

## 3. Objectives
1. Conduct structured mock interviews for three roles (Software Engineer,
   Data Analyst, HR/General) with difficulty levels.
2. Transcribe spoken answers locally (faster-whisper). Raw audio never leaves
   the machine. (When a Gemini key is set, only the text transcript is sent to
   the Gemini API for scoring, never the audio.)
3. Score every answer on content relevance, clarity/structure, and confidence (0–10).
4. Compute speech metrics for every answer: words-per-minute, filler-word count
   and rate, answer duration.
5. Select follow-up questions with vector retrieval over the question bank,
   grounded in what the candidate actually said (RAG loop).
6. Persist sessions and turns in SQLite and visualise trends on a dashboard.

## 4. Scope
- In scope: 3 roles × 18 curated questions; 5-question sessions; local STT;
  Gemini-based rubric scoring with graceful degradation when no API key is set;
  WPM / filler-word analytics; per-session reports; cross-session dashboard.
- Out of scope: video/body-language analysis, real-time interruption handling,
  multi-user accounts, deployment.

## 5. AI vs DS module split
| Module | Half | What it does |
|---|---|---|
| faster-whisper transcription | AI | Speech-to-text with a local transformer model |
| Gemini rubric scoring + feedback | AI | LLM-as-judge: 0–10 scores + coaching feedback |
| ChromaDB question retrieval | AI | Embeddings + vector search pick the next question from the answer transcript |
| `analytics.py` (WPM, filler stats) | DS | Descriptive statistics on every spoken answer |
| `score_trends`, `dimension_breakdown` | DS | Time-series and aggregate analysis across turns/sessions |
| Dashboard charts | DS | Visual analytics: score, WPM, and filler-rate trends |

## 6. Expected outcome
A working local app where a reviewer can run a full 5-question mock interview,
see per-answer transcripts, scores, feedback and speech metrics, and inspect
trend charts, demonstrating both an AI pipeline (STT → LLM judge → retrieval)
and a data-science layer (metrics, trends, breakdowns) on real user data.
