"""Backend contract shared by every ASR adapter."""

from __future__ import annotations

import gc
import time
from abc import ABC, abstractmethod
from typing import Any, Callable

import numpy as np

from ..config import ASRConfig
from ..errors import CancellationError, TranscriptionError
from ..registry import ModelSpec
from ..schemas import TranscriptionResult


class ASRBackend(ABC):
    backend_name = "base"
    supports_file = True
    supports_microphone = True
    supports_native_streaming = False
    supports_partial_results = False
    supports_word_timestamps = False
    supports_token_timestamps = False
    supports_segment_timestamps = False
    supports_language_detection = False
    supports_quantization = False

    def __init__(self, spec: ModelSpec, config: ASRConfig, store: Any) -> None:
        self.spec = spec
        self.config = config
        self.store = store
        self.effective_device = config.device
        self.effective_compute_type = config.compute_type or "auto"
        self.warnings: list[str] = []
        self._loaded = False
        self.load_seconds: float | None = None

    # ------------------------------------------------------------------ state
    @property
    def loaded(self) -> bool:
        return self._loaded

    def capabilities(self) -> dict[str, bool]:
        return {
            "file": self.supports_file,
            "microphone_chunked": self.supports_microphone,
            "native_streaming": self.supports_native_streaming,
            "partial_results": self.supports_partial_results,
            "word_timestamps": self.supports_word_timestamps,
            "token_timestamps": self.supports_token_timestamps,
            "segment_timestamps": self.supports_segment_timestamps,
            "language_detection": self.supports_language_detection,
            "quantization": self.supports_quantization,
        }

    def supported_languages(self) -> list[str]:
        return list(self.spec.languages)

    def health_check(self) -> dict[str, Any]:
        return {
            "ok": self._loaded,
            "loaded": self._loaded,
            "model_id": self.spec.id,
            "backend": self.backend_name,
            "device": self.effective_device,
            "compute_type": self.effective_compute_type,
            "capabilities": self.capabilities(),
            "warnings": list(self.warnings),
        }

    # --------------------------------------------------------------- lifecycle
    @abstractmethod
    def load(self, progress: Callable[[dict[str, Any]], None] | None = None, cancel_event: Any = None) -> None:
        raise NotImplementedError

    def unload(self) -> None:
        self._loaded = False
        gc.collect()
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def close(self) -> None:
        self.unload()

    # -------------------------------------------------------------- inference
    @abstractmethod
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
        raise NotImplementedError

    # ----------------------------------------------------------------- helpers
    def _check_cancel(self, cancel_event: Any) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise CancellationError("The transcription was canceled.")

    def _result(
        self,
        *,
        text: str,
        language: str | None = None,
        language_probability: float | None = None,
        segments=None,
        words=None,
        tokens=None,
        duration_seconds: float | None = None,
        warnings: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> TranscriptionResult:
        if not text or not text.strip():
            raise TranscriptionError("The model returned an empty transcript.")
        return TranscriptionResult(
            text=text.strip(),
            language=language,
            language_probability=language_probability,
            segments=segments,
            words=words,
            tokens=tokens,
            duration_seconds=duration_seconds,
            model_id=self.spec.id,
            backend=self.backend_name,
            device=self.effective_device,
            compute_type=self.effective_compute_type,
            warnings=list(warnings or []) + list(self.warnings),
            metadata=dict(metadata or {}),
        )

    @staticmethod
    def _elapsed(started: float) -> float:
        return round(max(0.0, time.monotonic() - started), 4)
