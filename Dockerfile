FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/.cache

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend

# Bake the ML models into the image so first boot is instant and needs no network.
# WHISPER_MODEL_SIZE matches the WHISPER_MODEL runtime env var (default "base").
ARG WHISPER_MODEL_SIZE=base
ENV WHISPER_MODEL_SIZE=${WHISPER_MODEL_SIZE}
RUN python - <<'EOF'
import os
from faster_whisper import WhisperModel
WhisperModel(os.environ.get("WHISPER_MODEL_SIZE", "base"), device="cpu", compute_type="int8")
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
DefaultEmbeddingFunction()(["warmup"])
print("models cached")
EOF

EXPOSE 7860
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "7860"]
