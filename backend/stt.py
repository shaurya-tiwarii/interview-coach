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
import logging
import os

import av
import av.error
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
    """Decode any audio file to 16 kHz mono float32, like faster-whisper does.

    NOTE: with PyAV >= 12 the resampler is a filter graph that enters EOF
    state once flushed. Flushing mid-stream (after every 500k-sample chunk)
    makes the *next* chunk raise av.error.EOFError, which broke every
    recording longer than ~10s. So frames are pushed chunk by chunk but the
    resampler is flushed exactly once, at the very end.
    """
    resampler = av.audio.resampler.AudioResampler(
        format="s16", layout="mono", rate=16000)
    raw_buffer = io.BytesIO()
    dtype = None

    def _drain(frame):
        nonlocal dtype
        for rf in resampler.resample(frame):
            arr = rf.to_ndarray()
            dtype = arr.dtype
            raw_buffer.write(arr)

    with av.open(path, mode="r") as container:
        fifo = av.audio.fifo.AudioFifo()
        for frame in container.decode(audio=0):
            frame.pts = None  # ignore timestamp check
            fifo.write(frame)
            if fifo.samples >= 500000:
                _drain(fifo.read())
        while fifo.samples > 0:
            _drain(fifo.read())
    _drain(None)  # final flush, once

    del resampler
    gc.collect()

    if dtype is None:
        return np.zeros(0, dtype=np.float32)
    audio = np.frombuffer(raw_buffer.getbuffer(), dtype=dtype)
    return (audio.astype(np.float32) / 32768.0)


def transcribe(audio_path: str) -> tuple[str, float]:
    """Transcribe an audio file. Returns (transcript_text, duration_seconds).

    An unreadable upload (empty/truncated blob) is treated as silence and
    follows the graceful empty-transcript path instead of 500ing.
    """
    try:
        waveform = _decode_audio_16k_mono(audio_path)
    except (av.error.FFmpegError, OSError) as e:
        log.warning("unreadable audio %s (%s); treating as silence", audio_path, e)
        return "", 0.0
    duration = round(len(waveform) / 16000, 2)
    if len(waveform) == 0:
        return "", 0.0
    model = _get_model()
    segments, _info = model.transcribe(waveform, beam_size=5)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text, duration
