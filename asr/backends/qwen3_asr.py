"""Qwen3-ASR adapter using the official qwen-asr Transformers backend."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..config import ASRConfig
from ..device import resolve_device, torch_dtype_for
from ..errors import (
    BackendUnavailableError,
    ModelLoadError,
    OutOfMemoryError,
    UnsupportedLanguageError,
    is_out_of_memory,
)
from ..registry import ModelSpec
from ..schemas import TranscriptionResult, Word
from .base import ASRBackend

ALIGNER_REPO_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
ALIGNER_DIR_NAME = "Qwen3-ForcedAligner-0.6B"

# qwen-asr accepts canonical English language names, not ISO codes.
QWEN_LANGUAGE_NAMES = {
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ar": "Arabic",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
    "id": "Indonesian",
    "it": "Italian",
    "ko": "Korean",
    "ru": "Russian",
    "th": "Thai",
    "vi": "Vietnamese",
    "ja": "Japanese",
    "tr": "Turkish",
    "hi": "Hindi",
    "ms": "Malay",
    "nl": "Dutch",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "pl": "Polish",
    "cs": "Czech",
    "fil": "Filipino",
    "fa": "Persian",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
    "mk": "Macedonian",
}
_CANONICAL_NAMES = {name.lower(): name for name in QWEN_LANGUAGE_NAMES.values()}


class Qwen3ASRBackend(ASRBackend):
    backend_name = "qwen-asr"
    supports_native_streaming = False
    supports_partial_results = False
    supports_word_timestamps = False  # becomes true when the optional aligner loads
    supports_segment_timestamps = False
    supports_language_detection = True

    def __init__(self, spec: ModelSpec, config: ASRConfig, store: Any) -> None:
        super().__init__(spec, config, store)
        self._model = None
        self._model_path = ""
        self._aligner_enabled = False
        self._aligner_path = ""

    def load(self, progress: Callable[[dict[str, Any]], None] | None = None, cancel_event: Any = None) -> None:
        started = time.monotonic()
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except ImportError as exc:
            raise BackendUnavailableError(
                "Qwen3-ASR needs the official qwen-asr package. Qwen recommends Python 3.12 and a "
                "fresh environment. Install whisper-server/requirements-asr-qwen.txt in an isolated "
                "Python environment and set VOXA_ASR_PYTHON to that interpreter."
            ) from exc
        device, warnings = resolve_device(self.config.device, framework="torch")
        self.warnings.extend(warnings)
        dtype_name = torch_dtype_for(device, self.config.compute_type)
        dtype = getattr(torch, dtype_name)
        path = self.store.resolve(self.spec, cancel_event)
        self._check_cancel(cancel_event)
        kwargs: dict[str, Any] = {
            "dtype": dtype,
            "device_map": "cuda:0" if device == "cuda" else "cpu",
            "max_inference_batch_size": 1,
            "max_new_tokens": 4096,
            "local_files_only": True,
        }
        if self.config.word_timestamps and _aligner_requested():
            aligner = _aligner_path(self.store)
            if aligner:
                kwargs["forced_aligner"] = aligner
                kwargs["forced_aligner_kwargs"] = {
                    "dtype": dtype,
                    "device_map": "cuda:0" if device == "cuda" else "cpu",
                    "local_files_only": True,
                }
                self._aligner_enabled = True
                self._aligner_path = aligner
            else:
                self.warnings.append(
                    "ASR_QWEN_ALIGNER is enabled but the Qwen3-ForcedAligner-0.6B weights were not "
                    f"found. Place them in {Path(self.store.cache_dir) / 'models' / ALIGNER_DIR_NAME} "
                    "or set ASR_QWEN_ALIGNER_PATH. Qwen timestamps stay disabled."
                )
        try:
            model = Qwen3ASRModel.from_pretrained(str(path), **kwargs)
        except Exception as exc:
            if is_out_of_memory(exc):
                raise OutOfMemoryError(f"Loading {self.spec.label} ran out of memory on {device}.") from exc
            raise ModelLoadError(f"Could not load {self.spec.label}: {exc}") from exc
        self._model = model
        self._model_path = str(path)
        self.effective_device = device
        self.effective_compute_type = dtype_name
        self.supports_word_timestamps = self._aligner_enabled
        self.load_seconds = self._elapsed(started)
        self._loaded = True
        self._check_cancel(cancel_event)

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
            raise ModelLoadError("The Qwen3-ASR model is not loaded.")
        self._check_cancel(cancel_event)
        started = time.monotonic()
        qwen_language = _language_name(language) if language else None
        want_timestamps = bool(word_timestamps and self._aligner_enabled)
        warnings: list[str] = []
        if word_timestamps and not self._aligner_enabled:
            warnings.append(
                "Qwen timestamps require the separate Qwen3-ForcedAligner-0.6B. Install its weights "
                "locally, set ASR_QWEN_ALIGNER=1 and ASR_QWEN_ALIGNER_PATH if needed, then reload."
            )
        try:
            results = self._model.transcribe(
                audio=(np.asarray(audio, dtype=np.float32), int(sample_rate)),
                language=qwen_language,
                return_time_stamps=want_timestamps,
            )
        except Exception as exc:
            if is_out_of_memory(exc):
                raise OutOfMemoryError(f"Qwen3-ASR ran out of memory on {self.effective_device}.") from exc
            raise
        if not results:
            raise ModelLoadError("Qwen3-ASR returned no results.")
        first = results[0]
        text = str(getattr(first, "text", "") or "").strip()
        detected = getattr(first, "language", None)
        words: list[Word] | None = None
        if want_timestamps:
            words = _words_from_aligner(getattr(first, "time_stamps", None), duration=len(audio) / sample_rate)
            if words is None:
                warnings.append("Qwen3-ASR returned no usable forced-alignment timestamps for this input.")
        return self._result(
            text=text,
            language=str(detected) if detected else None,
            language_probability=None,
            segments=None,
            words=words,
            duration_seconds=len(audio) / float(sample_rate),
            warnings=warnings,
            metadata={
                "inference_seconds": self._elapsed(started),
                "timestamp_granularity": "word_or_character" if words else None,
                "language_label": "canonical_name" if detected else None,
                "vad_applied": False,
            },
        )

    def unload(self) -> None:
        self._model = None
        self._model_path = ""
        self._aligner_path = ""
        self._aligner_enabled = False
        self.supports_word_timestamps = False
        super().unload()

    def health_check(self) -> dict[str, Any]:
        payload = super().health_check()
        payload["model_path"] = self._model_path
        payload["forced_aligner"] = self._aligner_enabled
        payload["forced_aligner_path"] = self._aligner_path
        return payload


def _aligner_requested() -> bool:
    return str(os.getenv("ASR_QWEN_ALIGNER", "")).strip().lower() in {"1", "true", "yes", "on"}


def _aligner_path(store: Any) -> str | None:
    explicit = str(os.getenv("ASR_QWEN_ALIGNER_PATH", "")).strip()
    candidate = Path(explicit).expanduser() if explicit else Path(store.cache_dir) / "models" / ALIGNER_DIR_NAME
    try:
        if not candidate.is_dir():
            return None
        if not (candidate / "config.json").is_file():
            return None
        if not any(candidate.glob("model*.safetensors")):
            if not (candidate / "pytorch_model.bin").is_file():
                return None
    except OSError:
        return None
    return str(candidate)


def _language_name(language: str) -> str:
    text = str(language or "").strip()
    key = text.lower()
    if key in QWEN_LANGUAGE_NAMES:
        return QWEN_LANGUAGE_NAMES[key]
    if key in _CANONICAL_NAMES:
        return _CANONICAL_NAMES[key]
    raise UnsupportedLanguageError(
        f"Qwen3-ASR does not support the language hint '{text}'.",
        details={
            "supported": sorted(QWEN_LANGUAGE_NAMES.values()),
            "codes": sorted(QWEN_LANGUAGE_NAMES),
        },
    )


def _words_from_aligner(value: Any, *, duration: float) -> list[Word] | None:
    if value is None:
        return None
    items = getattr(value, "items", value)
    if isinstance(items, dict):
        items = [items]
    try:
        items = list(items)
    except TypeError:
        return None
    words: list[Word] = []
    for item in items:
        if isinstance(item, dict):
            text = item.get("text") or item.get("word")
            start = item.get("start_time", item.get("start"))
            end = item.get("end_time", item.get("end"))
        else:
            text = getattr(item, "text", None) or getattr(item, "word", None)
            start = getattr(item, "start_time", None)
            if start is None:
                start = getattr(item, "start", None)
            end = getattr(item, "end_time", None)
            if end is None:
                end = getattr(item, "end", None)
        if not text or not str(text).strip():
            continue
        start_value = _time(start, duration)
        end_value = _time(end, duration)
        if start_value is None or end_value is None:
            continue
        words.append(Word(text=str(text).strip(), start=start_value, end=end_value))
    return words or None


def _time(value: Any, duration: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(number):
        return None
    if not (0.0 <= number <= max(duration + 1.0, 1.0)):
        return None
    return round(number, 3)
