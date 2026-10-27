"""Verified faster-whisper / CTranslate2 adapter."""

from __future__ import annotations

import gc
import time
from typing import Any, Callable

import numpy as np

from ..config import ASRConfig
from ..device import compute_type_for, resolve_device
from ..errors import DeviceUnavailableError, ModelLoadError, OutOfMemoryError, is_out_of_memory
from ..registry import ModelSpec
from ..schemas import Segment, TranscriptionResult, Word
from .base import ASRBackend

CUDA_LIBRARY_MARKERS = ("cublas", "cudnn", "cuda", "nvcuda", "nvrtc", "no cuda-capable")


def _cuda_library_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in CUDA_LIBRARY_MARKERS)


class FasterWhisperBackend(ASRBackend):
    backend_name = "faster-whisper"
    supports_native_streaming = False
    supports_partial_results = False
    supports_word_timestamps = True
    supports_segment_timestamps = True
    supports_language_detection = True
    supports_quantization = True

    def __init__(self, spec: ModelSpec, config: ASRConfig, store: Any) -> None:
        super().__init__(spec, config, store)
        self._model = None
        self._model_path = ""

    def load(self, progress: Callable[[dict[str, Any]], None] | None = None, cancel_event: Any = None) -> None:
        from faster_whisper import WhisperModel

        started = time.monotonic()
        device, warnings = resolve_device(self.config.device, framework="ctranslate2")
        compute_type = compute_type_for(device, self.config.compute_type)
        self.warnings.extend(warnings)
        path = self.store.resolve(self.spec, cancel_event)
        self._check_cancel(cancel_event)
        last_error: BaseException | None = None
        while True:
            try:
                model = WhisperModel(
                    str(path),
                    device=device,
                    compute_type=compute_type,
                    local_files_only=True,
                )
                if device == "cuda":
                    # Force cuBLAS/cuDNN to load before declaring the model ready.
                    warm = np.zeros(16000, dtype=np.float32)
                    segments, _info = model.transcribe(
                        warm,
                        beam_size=1,
                        vad_filter=False,
                        condition_on_previous_text=False,
                    )
                    for _segment in segments:
                        pass
                self._model = model
                self._model_path = str(path)
                self.effective_device = device
                self.effective_compute_type = compute_type
                self.load_seconds = self._elapsed(started)
                self._loaded = True
                self._check_cancel(cancel_event)
                return
            except Exception as exc:
                last_error = exc
                if is_out_of_memory(exc):
                    raise OutOfMemoryError(f"Loading {self.spec.label} ran out of memory on {device}.") from exc
                can_fallback = (
                    device == "cuda"
                    and self.config.device == "auto"
                    and self.config.allow_cpu_fallback
                    and _cuda_library_error(exc)
                )
                if not can_fallback:
                    if device == "cuda" and _cuda_library_error(exc):
                        raise DeviceUnavailableError(
                            "CUDA was requested but the CTranslate2 CUDA libraries could not be loaded. "
                            f"Choose CPU explicitly or install the matching cuBLAS/cuDNN runtime. ({exc})"
                        ) from exc
                    raise ModelLoadError(f"Could not load {self.spec.label}: {exc}") from exc
                self.warnings.append(
                    f"CUDA could not be initialized ({exc}); faster-whisper is using CPU int8 instead."
                )
                device = "cpu"
                compute_type = "int8"
                gc.collect()
        # The loop either returns or raises; keep the last error for type checkers.
        raise ModelLoadError(f"Could not load {self.spec.label}: {last_error}")  # pragma: no cover

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        *,
        language: str | None = None,
        word_timestamps: bool = False,
        vad: bool = True,
        cancel_event: Any = None,
    ) -> TranscriptionResult:
        if self._model is None:
            raise ModelLoadError("The faster-whisper model is not loaded.")
        self._check_cancel(cancel_event)
        started = time.monotonic()
        try:
            segments_iter, info = self._model.transcribe(
                np.asarray(audio, dtype=np.float32),
                language=language or None,
                beam_size=self.config.beam_size,
                best_of=self.config.best_of,
                vad_filter=bool(vad),
                word_timestamps=bool(word_timestamps),
                condition_on_previous_text=bool(self.config.condition_on_previous_text),
            )
            segments: list[Segment] = []
            words: list[Word] | None = [] if word_timestamps else None
            pieces: list[str] = []
            for segment in segments_iter:
                self._check_cancel(cancel_event)
                text = str(getattr(segment, "text", "") or "").strip()
                if not text:
                    continue
                pieces.append(text)
                start = _number(getattr(segment, "start", None))
                end = _number(getattr(segment, "end", None))
                segments.append(Segment(text=text, start=start, end=end))
                if words is not None:
                    for word in getattr(segment, "words", None) or []:
                        word_text = str(getattr(word, "word", "") or "").strip()
                        if not word_text:
                            continue
                        probability = getattr(word, "probability", None)
                        words.append(
                            Word(
                                text=word_text,
                                start=_number(getattr(word, "start", None)),
                                end=_number(getattr(word, "end", None)),
                                confidence=float(probability) if probability is not None else None,
                            )
                        )
            text = " ".join(pieces).strip()
            duration = _number(getattr(info, "duration", None))
            if duration is None:
                duration = len(audio) / float(sample_rate)
            language_value = getattr(info, "language", None) or language
            probability = getattr(info, "language_probability", None)
            return self._result(
                text=text,
                language=str(language_value) if language_value else None,
                language_probability=float(probability) if probability is not None else None,
                segments=segments or None,
                words=words if words else None,
                duration_seconds=duration,
                metadata={
                    "inference_seconds": self._elapsed(started),
                    "word_timestamps_requested": bool(word_timestamps),
                },
            )
        except OutOfMemoryError:
            raise
        except Exception as exc:
            if is_out_of_memory(exc):
                raise OutOfMemoryError(f"Transcription ran out of memory on {self.effective_device}.") from exc
            raise

    def unload(self) -> None:
        self._model = None
        self._model_path = ""
        super().unload()

    def health_check(self) -> dict[str, Any]:
        payload = super().health_check()
        payload.update({"model_path": self._model_path})
        return payload


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 3) if number == number else None
