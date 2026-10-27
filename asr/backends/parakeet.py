"""NVIDIA Parakeet TDT adapter using the official Transformers path.

The official processor returns *token* timestamps (seconds), never word
timestamps. ``tokens`` is therefore a separate result field; nothing here
relabels sub-word pieces as words.
"""

from __future__ import annotations

import time
from typing import Any, Callable

import numpy as np

from ..config import ASRConfig
from ..device import resolve_device, torch_dtype_for
from ..errors import BackendUnavailableError, ModelLoadError, OutOfMemoryError, is_out_of_memory
from ..registry import ModelSpec
from ..schemas import Token, TranscriptionResult
from .base import ASRBackend


class ParakeetBackend(ASRBackend):
    backend_name = "transformers-tdt"
    supports_native_streaming = False
    supports_partial_results = False
    supports_word_timestamps = False
    supports_token_timestamps = True
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
            from transformers import AutoModelForTDT, AutoProcessor
        except ImportError as exc:
            raise BackendUnavailableError(
                "Parakeet TDT needs the optional Transformers runtime. Install "
                "whisper-server/requirements-asr-parakeet.txt in an isolated Python environment "
                "and set VOXA_ASR_PYTHON to that interpreter."
            ) from exc
        device, warnings = resolve_device(self.config.device, framework="torch")
        self.warnings.extend(warnings)
        dtype_name = torch_dtype_for(device, self.config.compute_type)
        dtype = getattr(torch, dtype_name)
        if self.config.language:
            self.warnings.append(
                "Parakeet selects the language internally; ASR_LANGUAGE/--language is not passed to the model."
            )
        path = self.store.resolve(self.spec, cancel_event)
        self._check_cancel(cancel_event)
        try:
            processor = AutoProcessor.from_pretrained(str(path), local_files_only=True)
            try:
                model = AutoModelForTDT.from_pretrained(str(path), dtype=dtype, local_files_only=True)
            except TypeError:
                model = AutoModelForTDT.from_pretrained(str(path), torch_dtype=dtype, local_files_only=True)
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
        if self._model is None or self._processor is None or self._torch is None:
            raise ModelLoadError("The Parakeet model is not loaded.")
        if int(sample_rate) != int(self._sample_rate):
            raise ModelLoadError(
                f"Parakeet expects {self._sample_rate} Hz audio but received {sample_rate} Hz."
            )
        self._check_cancel(cancel_event)
        started = time.monotonic()
        try:
            inputs = self._processor(
                np.asarray(audio, dtype=np.float32),
                sampling_rate=self._sample_rate,
                return_tensors="pt",
            )
            inputs = inputs.to(device=self._model.device, dtype=self._model.dtype)
            output = self._model.generate(**inputs)
            sequences = getattr(output, "sequences", output)
            durations = getattr(output, "durations", None)
            tokens: list[Token] | None = None
            if word_timestamps and durations is not None:
                decoded, timestamps = self._processor.decode(
                    sequences,
                    durations=durations,
                    skip_special_tokens=True,
                )
                text = _first_text(decoded)
                tokens = _tokens_from_timestamps(timestamps, duration=len(audio) / float(sample_rate))
                if tokens is None:
                    self.warnings.append(
                        "Parakeet returned no usable token timestamps for this input; timestamps are omitted."
                    )
            else:
                text = _first_text(self._processor.decode(sequences, skip_special_tokens=True))
            return self._result(
                text=text,
                language=None,
                language_probability=None,
                segments=None,
                words=None,
                tokens=tokens,
                duration_seconds=len(audio) / float(sample_rate),
                metadata={
                    "inference_seconds": self._elapsed(started),
                    "timestamp_granularity": "token" if tokens else None,
                    "language_metadata": "not_exposed",
                    "vad_applied": False,
                },
            )
        except OutOfMemoryError:
            raise
        except Exception as exc:
            if is_out_of_memory(exc):
                raise OutOfMemoryError(f"Parakeet ran out of memory on {self.effective_device}.") from exc
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


def _first_text(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return str(value or "").strip()


def _tokens_from_timestamps(value: Any, *, duration: float) -> list[Token] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        items = list(value)
        # The processor returns one timestamp list per batch item.
        if items and isinstance(items[0], (list, tuple)) and not isinstance(items[0], dict):
            items = list(items[0])
    elif isinstance(value, dict):
        items = [value]
    else:
        return None
    tokens: list[Token] = []
    for item in items:
        if isinstance(item, dict):
            text = item.get("token") or item.get("text")
            start = item.get("start", item.get("start_time"))
            end = item.get("end", item.get("end_time"))
        else:
            text = getattr(item, "token", None) or getattr(item, "text", None)
            start = getattr(item, "start", None) or getattr(item, "start_time", None)
            end = getattr(item, "end", None) or getattr(item, "end_time", None)
        if not text or not str(text).strip():
            continue
        start_value = _time(start, duration)
        end_value = _time(end, duration)
        if start_value is None or end_value is None:
            continue
        tokens.append(Token(text=str(text).strip(), start=start_value, end=end_value))
    return tokens or None


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
