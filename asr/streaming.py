"""Microphone capture and chunked streaming helpers.

None of the supported local backends expose native streaming through this
subsystem: Qwen3-ASR streaming requires its vLLM runtime, and the other models
are utterance/file models. Microphone input is therefore captured as one
utterance (energy-based start/stop detection) and transcribed when it ends.
``iter_chunked`` is the same chunking used for long files and is not presented
as partial or real-time results.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from typing import Any, Callable, Iterator

import numpy as np

from .config import ASRConfig
from .errors import AudioInputError, CancellationError, DeviceUnavailableError
from .manager import ASRManager
from .schemas import TranscriptionResult

BLOCK_MS = 30
DEFAULT_START_TIMEOUT_SECONDS = 30.0
# The same near-silence threshold the Electron recorder uses. Calibration is
# deliberately simple and documented; no model is asked to hallucinate speech.
DEFAULT_RMS_THRESHOLD = 0.005
PRE_ROLL_SECONDS = 0.3


@dataclass
class CapturedAudio:
    audio: np.ndarray
    sample_rate: int
    duration_seconds: float
    peak_rms: float
    speech_detected: bool


def _rms(block: np.ndarray) -> float:
    if block.size == 0:
        return 0.0
    return math.sqrt(float(np.mean(np.square(block, dtype=np.float64))))


def capture_utterance(
    config: ASRConfig,
    *,
    device: str | int | None = None,
    silence_ms: int | None = None,
    max_seconds: float | None = None,
    start_timeout: float = DEFAULT_START_TIMEOUT_SECONDS,
    threshold: float = DEFAULT_RMS_THRESHOLD,
    cancel_event: threading.Event | None = None,
    on_level: Callable[[float], None] | None = None,
    sounddevice_module: Any = None,
) -> CapturedAudio:
    """Capture one utterance from the microphone using energy VAD.

    The function waits up to ``start_timeout`` for speech, then stops after
    ``silence_ms`` of non-speech (default 900 ms) or ``max_seconds``. It raises
    rather than returning fabricated silence when no speech is detected.
    """
    sample_rate = int(config.sample_rate)
    silence = int(silence_ms if silence_ms is not None else config.mic_silence_ms)
    limit = float(max_seconds if max_seconds is not None else config.mic_max_seconds)
    if sounddevice_module is None:
        try:
            import sounddevice as sd  # type: ignore
        except Exception as exc:
            raise DeviceUnavailableError(
                "Microphone capture needs the optional sounddevice package. "
                "Install it with: pip install sounddevice"
            ) from exc
    else:
        sd = sounddevice_module

    block_size = max(1, int(sample_rate * BLOCK_MS / 1000))
    pre_roll_blocks = max(1, int(PRE_ROLL_SECONDS * 1000 / BLOCK_MS))
    voiced_seconds_needed = 0.12
    try:
        stream = sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            blocksize=block_size,
            device=device,
        )
    except Exception as exc:
        raise DeviceUnavailableError(f"Could not open the microphone: {exc}") from exc

    frames: list[np.ndarray] = []
    pre_roll: list[np.ndarray] = []
    speech_started = False
    speech_time = 0.0
    silence_seconds = 0.0
    peak_rms = 0.0
    listened_samples = 0
    recorded_samples = 0
    try:
        with stream:
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise CancellationError("Microphone capture was canceled.")
                block = stream.read(block_size)
                data = np.asarray(block, dtype=np.float32).reshape(-1)
                if data.size == 0:
                    continue
                listened_samples += data.size
                level = _rms(data)
                peak_rms = max(peak_rms, level)
                if on_level is not None:
                    try:
                        on_level(level)
                    except Exception:
                        pass
                just_started = False
                if not speech_started:
                    pre_roll.append(data.copy())
                    pre_roll = pre_roll[-pre_roll_blocks:]
                    if level >= threshold:
                        speech_time += data.size / sample_rate
                        if speech_time >= voiced_seconds_needed:
                            speech_started = True
                            just_started = True
                            frames.extend(pre_roll)
                            recorded_samples = sum(item.size for item in pre_roll)
                            silence_seconds = 0.0
                    else:
                        speech_time = max(0.0, speech_time - BLOCK_MS / 2000.0)
                    if not speech_started and listened_samples / sample_rate > start_timeout:
                        raise AudioInputError("No speech was detected before the microphone timeout.")
                    if not speech_started or just_started:
                        continue
                if speech_started:
                    frames.append(data.copy())
                    recorded_samples += data.size
                    if level >= threshold * 0.75:
                        silence_seconds = 0.0
                    else:
                        silence_seconds += data.size / sample_rate
                    if silence_seconds * 1000 >= silence:
                        break
                    if recorded_samples / sample_rate >= limit:
                        break
    except (CancellationError, AudioInputError):
        raise
    except Exception as exc:
        raise DeviceUnavailableError(f"Microphone capture failed: {exc}") from exc

    if not speech_started or not frames:
        raise AudioInputError("No speech was detected in the microphone recording.")
    audio = np.ascontiguousarray(np.concatenate(frames).astype(np.float32, copy=False))
    duration = float(audio.size) / float(sample_rate)
    if duration > limit + 1.0:
        audio = audio[: int(limit * sample_rate)]
        duration = float(audio.size) / float(sample_rate)
    return CapturedAudio(
        audio=audio,
        sample_rate=sample_rate,
        duration_seconds=duration,
        peak_rms=peak_rms,
        speech_detected=True,
    )


def transcribe_microphone(
    manager: ASRManager,
    config: ASRConfig,
    *,
    model_id: str | None = None,
    device: str | int | None = None,
    language: str | None = None,
    word_timestamps: bool | None = None,
    cancel_event: threading.Event | None = None,
    on_level: Callable[[float], None] | None = None,
) -> tuple[TranscriptionResult, CapturedAudio]:
    # Load first so the microphone is not held open while a model downloads.
    manager.wait_until_ready(model_id, cancel_event=cancel_event)
    captured = capture_utterance(
        config,
        device=device,
        cancel_event=cancel_event,
        on_level=on_level,
    )
    result = manager.transcribe_audio(
        captured.audio,
        captured.sample_rate,
        model_id=model_id,
        language=language,
        word_timestamps=word_timestamps,
        vad=bool(config.vad),
        cancel_event=cancel_event,
        auto_load=False,
    )
    return result, captured


def iter_chunked(
    audio: np.ndarray,
    sample_rate: int,
    chunk_seconds: float,
) -> Iterator[tuple[int, float, float, np.ndarray]]:
    """Yield ``(index, start, end, samples)`` fixed-size audio chunks."""
    if chunk_seconds <= 0:
        raise AudioInputError("Chunk seconds must be positive.")
    size = max(1, int(round(chunk_seconds * sample_rate)))
    data = np.asarray(audio, dtype=np.float32).reshape(-1)
    index = 0
    for start in range(0, data.size, size):
        end = min(data.size, start + size)
        yield index, start / sample_rate, end / sample_rate, np.ascontiguousarray(data[start:end])
        index += 1
