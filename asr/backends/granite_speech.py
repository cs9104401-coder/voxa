"""IBM Granite Speech 5.0 TurboCTC adapter (official Transformers CTC path)."""

from __future__ import annotations

import time
from typing import Any, Callable

import numpy as np

from ..config import ASRConfig
from ..device import resolve_device, torch_dtype_for
from ..errors import BackendUnavailableError, ModelLoadError, OutOfMemoryError, is_out_of_memory
from ..registry import ModelSpec
from ..schemas import TranscriptionResult
from .base import ASRBackend


class GraniteSpeechBackend(ASRBackend):
    backend_name = "granite-transformers"
    supports_native_streaming = False
    supports_partial_results = False
    supports_word_timestamps = False
    supports_token_timestamps = False
    supports_segment_timestamps = False
    supports_language_detection = False

    def __init__(self, spec: ModelSpec, config: ASRConfig, store: Any) -> None:
        super().__init__(spec, config, store)
        self._processor = None
        self._model = None
        self._torch = None
        self._model_path = ""
        self._sample_rate = 16000

    def load(self, progress: Callable[[dict[str, Any]], None] | None = None, cancel_event: Any = None) -> None:
        started = time.monotonic()
        try:
            import torch
            from transformers import AutoModelForCTC, AutoProcessor
        except ImportError as exc:
            raise BackendUnavailableError(
                "Granite Speech needs torch and transformers>=5.16.0. Install "
                "whisper-server/requirements-asr-granite.txt in an isolated Python environment "
                "and set VOXA_ASR_PYTHON to that interpreter."
            ) from exc
        device, warnings = resolve_device(self.config.device, framework="torch")
        self.warnings.extend(warnings)
        dtype_name = torch_dtype_for(device, self.config.compute_type)
        dtype = getattr(torch, dtype_name)
        if self.config.language:
            self.warnings.append(
                "Granite TurboCTC has no language-hint interface; ASR_LANGUAGE/--language is not passed to the model."
            )
        path = self.store.resolve(self.spec, cancel_event)
        self._check_cancel(cancel_event)
        try:
            processor = AutoProcessor.from_pretrained(str(path), local_files_only=True)
            try:
                model = AutoModelForCTC.from_pretrained(str(path), dtype=dtype, local_files_only=True)
            except TypeError:
                model = AutoModelForCTC.from_pretrained(str(path), torch_dtype=dtype, local_files_only=True)
            model.to(device)
            model.eval()
        except Exception as exc:
            if is_out_of_memory(exc):
                raise OutOfMemoryError(f"Loading {self.spec.label} ran out of memory on {device}.") from exc
            raise ModelLoadError(f"Could not load {self.spec.label}: {exc}") from exc
        self._torch = torch
        self._processor = processor
        self._model = model
        self._model_path = str(path)
        self._sample_rate = int(getattr(processor.feature_extractor, "sampling_rate", 16000))
        self.effective_device = device
        self.effective_compute_type = dtype_name
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
        if self._model is None or self._processor is None:
            raise ModelLoadError("The Granite Speech model is not loaded.")
        if int(sample_rate) != int(self._sample_rate):
            raise ModelLoadError(
                f"Granite Speech expects {self._sample_rate} Hz audio but received {sample_rate} Hz."
            )
        warnings: list[str] = []
        if word_timestamps:
            warnings.append("Granite TurboCTC is a CTC model and does not provide timestamps.")
        self._check_cancel(cancel_event)
        started = time.monotonic()
        try:
            samples = np.asarray(audio, dtype=np.float32)
            try:
                inputs = self._processor(
                    samples,
                    sampling_rate=self._sample_rate,
                    return_tensors="pt",
                    device=self._model.device,
                )
            except TypeError:
                inputs = self._processor(
                    samples,
                    sampling_rate=self._sample_rate,
                    return_tensors="pt",
                )
            inputs = inputs.to(device=self._model.device, dtype=self._model.dtype)
            outputs = self._model.generate(**inputs)
            decoded = self._processor.batch_decode(outputs, skip_special_tokens=True)
            text = decoded[0] if isinstance(decoded, (list, tuple)) else str(decoded)
            return self._result(
                text=str(text or ""),
                language=None,
                language_probability=None,
                segments=None,
                words=None,
                tokens=None,
                duration_seconds=len(audio) / float(sample_rate),
                warnings=warnings,
                metadata={
                    "inference_seconds": self._elapsed(started),
                    "decoding": "greedy_ctc",
                    "language_metadata": "not_exposed",
                    "vad_applied": False,
                },
            )
        except OutOfMemoryError:
            raise
        except Exception as exc:
            if is_out_of_memory(exc):
                raise OutOfMemoryError(f"Granite Speech ran out of memory on {self.effective_device}.") from exc
            raise

    def unload(self) -> None:
        self._model = None
        self._processor = None
        self._model_path = ""
        super().unload()

    def health_check(self) -> dict[str, Any]:
        payload = super().health_check()
        payload["model_path"] = self._model_path
        return payload
