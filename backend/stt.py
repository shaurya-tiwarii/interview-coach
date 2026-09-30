"""Speech-to-text via faster-whisper (local model, no API calls).

The model is loaded lazily on first transcription and cached for the process
lifetime. WHISPER_MODEL env var selects the size (default "base").

Audio decoding note: this project's pinned faster-whisper (1.2.1) passes a
`metadata_errors` keyword to `av.open()`, which the pinned PyAV (19.0.0) no
longer accepts. To stay compatible, audio is decoded here with PyAV's stable
API (mirroring faster-whisper's own decode_audio, minus that keyword) and the
resulting 16 kHz mono float32 waveform is handed to faster-whisper, which
natively accepts numpy arrays.
"""
import gc
import io
import itertools
import logging
import os

import av
import numpy as np

log = logging.getLogger(__name__)

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        size = os.environ.get("WHISPER_MODEL", "base")
        log.info("loading faster-whisper model %s (first run downloads it)", size)
        _model = WhisperModel(size, device="cpu", compute_type="int8")
    return _model


def _decode_audio_16k_mono(path: str) -> np.ndarray:
    """Decode any audio file to 16 kHz mono float32, like faster-whisper does."""
    resampler = av.audio.resampler.AudioResampler(
        format="s16", layout="mono", rate=16000)
    raw_buffer = io.BytesIO()
    dtype = None

    with av.open(path, mode="r") as container:
        fifo = av.audio.fifo.AudioFifo()
        frames = container.decode(audio=0)
        for frame in frames:
            frame.pts = None  # ignore timestamp check
            fifo.write(frame)
            if fifo.samples >= 500000:
                out = fifo.read()
                for r in itertools.chain([out], [None]):
                    for rf in resampler.resample(r):
                        arr = rf.to_ndarray()
                        dtype = arr.dtype
                        raw_buffer.write(arr)
        if fifo.samples > 0:
            out = fifo.read()
            for rf in itertools.chain([out], [None]):
                for rrf in resampler.resample(rf):
                    arr = rrf.to_ndarray()
                    dtype = arr.dtype
                    raw_buffer.write(arr)

    del resampler
    gc.collect()

    if dtype is None:
        return np.zeros(0, dtype=np.float32)
    audio = np.frombuffer(raw_buffer.getbuffer(), dtype=dtype)
    return (audio.astype(np.float32) / 32768.0)


def transcribe(audio_path: str) -> tuple[str, float]:
    """Transcribe an audio file. Returns (transcript_text, duration_seconds)."""
    model = _get_model()
    waveform = _decode_audio_16k_mono(audio_path)
    duration = round(len(waveform) / 16000, 2)
    segments, _info = model.transcribe(waveform, beam_size=5)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text, duration
