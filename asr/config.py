"""Validated runtime configuration for the ASR subsystem."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping

from .errors import ASRError

DEVICES = ("auto", "cpu", "cuda")
# Only backends that are actually implemented are accepted. Keeping the list
# short means ASR_BACKEND cannot select a path that would silently do nothing.
BACKENDS = (
    "auto",
    "faster-whisper",
    "transformers",
    "transformers-tdt",
    "qwen-asr",
    "granite-transformers",
)
LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG")


def _default_cache_dir() -> str:
    override = os.getenv("ASR_MODEL_CACHE", "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if sys.platform == "win32":
        base = os.getenv("APPDATA") or os.getenv("LOCALAPPDATA") or str(Path.home())
        # Match the Electron app's userData directory so a service started by
        # the app and a CLI run share one cache without extra configuration.
        return str(Path(base) / "my-voice-app" / "asr-models")
    return str(Path.home() / ".cache" / "voxa" / "asr-models")


def _env(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _bool(value: str, name: str) -> bool:
    text = value.strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise ASRError(f"{name} must be true/false, 1/0, yes/no, or on/off.")


def _int(value: str, name: str, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ASRError(f"{name} must be an integer.") from exc
    if number < minimum or number > maximum:
        raise ASRError(f"{name} must be between {minimum} and {maximum}.")
    return number


def _float(value: str, name: str, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ASRError(f"{name} must be a number.") from exc
    if number < minimum or number > maximum:
        raise ASRError(f"{name} must be between {minimum} and {maximum}.")
    return number


@dataclass
class ASRConfig:
    model: str = "whisper-large-v3-turbo"
    backend: str = "auto"
    device: str = "auto"
    compute_type: str = ""
    cache_dir: str = field(default_factory=_default_cache_dir)
    language: str | None = None
    word_timestamps: bool = False
    vad: bool = True
    chunk_seconds: float = 30.0
    log_level: str = "INFO"
    offline: bool = False
    beam_size: int = 5
    best_of: int = 5
    condition_on_previous_text: bool = False
    max_audio_seconds: float = 4 * 3600
    sample_rate: int = 16000
    mic_device: str | None = None
    mic_silence_ms: int = 900
    mic_max_seconds: float = 120.0
    allow_cpu_fallback: bool = True
    service_token: str | None = None

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        self.model = str(self.model or "").strip()
        if not self.model or len(self.model) > 200:
            raise ASRError("ASR_MODEL must be a model id or directory between 1 and 200 characters.")
        self.backend = str(self.backend or "auto").strip().lower()
        if self.backend not in BACKENDS:
            raise ASRError(f"ASR_BACKEND must be one of {', '.join(BACKENDS)}.")
        self.device = str(self.device or "auto").strip().lower()
        if self.device not in DEVICES:
            raise ASRError(f"ASR_DEVICE must be one of {', '.join(DEVICES)}.")
        self.compute_type = str(self.compute_type or "").strip().lower()
        if len(self.compute_type) > 40:
            raise ASRError("ASR_COMPUTE_TYPE is too long.")
        self.cache_dir = os.path.abspath(os.path.expanduser(str(self.cache_dir or _default_cache_dir())))
        if self.language is not None:
            self.language = str(self.language).strip() or None
            if self.language and len(self.language) > 40:
                raise ASRError("ASR_LANGUAGE must be at most 40 characters, or empty for auto.")
        if not (1 <= float(self.chunk_seconds) <= 120):
            raise ASRError("ASR_CHUNK_SECONDS must be between 1 and 120.")
        self.chunk_seconds = float(self.chunk_seconds)
        self.log_level = str(self.log_level or "INFO").strip().upper()
        if self.log_level not in LOG_LEVELS:
            raise ASRError(f"ASR_LOG_LEVEL must be one of {', '.join(LOG_LEVELS)}.")
        if not (1 <= int(self.beam_size) <= 20):
            raise ASRError("ASR beam size must be between 1 and 20.")
        if not (1 <= int(self.best_of) <= 20):
            raise ASRError("ASR best_of must be between 1 and 20.")
        self.beam_size = int(self.beam_size)
        self.best_of = int(self.best_of)
        if not (1 <= float(self.max_audio_seconds) <= 14400):
            raise ASRError("ASR max audio must be between 1 second and 4 hours.")
        self.max_audio_seconds = float(self.max_audio_seconds)
        if int(self.sample_rate) not in (8000, 16000, 22050, 24000, 32000, 44100, 48000):
            raise ASRError("ASR sample rate is not supported.")
        self.sample_rate = int(self.sample_rate)
        if not (50 <= int(self.mic_silence_ms) <= 10000):
            raise ASRError("ASR mic silence must be between 50 and 10000 ms.")
        self.mic_silence_ms = int(self.mic_silence_ms)
        if not (1 <= float(self.mic_max_seconds) <= 3600):
            raise ASRError("ASR mic max seconds must be between 1 and 3600.")
        self.mic_max_seconds = float(self.mic_max_seconds)
        if self.service_token is not None:
            token = str(self.service_token).strip()
            if not token or len(token) > 200 or any(ch in token for ch in "\r\n"):
                raise ASRError("The ASR service token must be a non-empty single line of at most 200 characters.")
            self.service_token = token

    def with_device(self, device: str, compute_type: str = "") -> "ASRConfig":
        return replace(self, device=device, compute_type=compute_type)

    def as_public_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "backend": self.backend,
            "device": self.device,
            "compute_type": self.compute_type,
            "cache_dir": self.cache_dir,
            "language": self.language,
            "word_timestamps": self.word_timestamps,
            "vad": self.vad,
            "chunk_seconds": self.chunk_seconds,
            "offline": self.offline,
            "beam_size": self.beam_size,
            "best_of": self.best_of,
            "log_level": self.log_level,
            "max_audio_seconds": self.max_audio_seconds,
        }

    @classmethod
    def from_env(
        cls,
        overrides: Mapping[str, Any] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> "ASRConfig":
        """Build config with precedence: explicit overrides > environment > defaults."""
        source = os.environ if env is None else env
        values: dict[str, Any] = {}
        mapping = {
            "ASR_MODEL": ("model", str),
            "ASR_BACKEND": ("backend", str),
            "ASR_DEVICE": ("device", str),
            "ASR_COMPUTE_TYPE": ("compute_type", str),
            "ASR_MODEL_CACHE": ("cache_dir", str),
            "ASR_LANGUAGE": ("language", str),
            "ASR_LOG_LEVEL": ("log_level", str),
            "ASR_SERVICE_TOKEN": ("service_token", str),
        }
        for variable, (field_name, caster) in mapping.items():
            raw = _env(source, variable)
            if raw is not None:
                values[field_name] = caster(raw)
        bool_mapping = {
            "ASR_WORD_TIMESTAMPS": "word_timestamps",
            "ASR_VAD": "vad",
            "ASR_OFFLINE": "offline",
            "ASR_CPU_FALLBACK": "allow_cpu_fallback",
        }
        for variable, field_name in bool_mapping.items():
            raw = _env(source, variable)
            if raw is not None:
                values[field_name] = _bool(raw, variable)
        if _env(source, "ASR_CHUNK_SECONDS") is not None:
            values["chunk_seconds"] = _float(str(_env(source, "ASR_CHUNK_SECONDS")), "ASR_CHUNK_SECONDS", 1, 120)
        if _env(source, "ASR_BEAM_SIZE") is not None:
            values["beam_size"] = _int(str(_env(source, "ASR_BEAM_SIZE")), "ASR_BEAM_SIZE", 1, 20)
        if _env(source, "ASR_BEST_OF") is not None:
            values["best_of"] = _int(str(_env(source, "ASR_BEST_OF")), "ASR_BEST_OF", 1, 20)
        if _env(source, "ASR_MIC_DEVICE") is not None:
            values["mic_device"] = str(_env(source, "ASR_MIC_DEVICE"))
        if _env(source, "ASR_MAX_AUDIO_SECONDS") is not None:
            values["max_audio_seconds"] = _float(
                str(_env(source, "ASR_MAX_AUDIO_SECONDS")), "ASR_MAX_AUDIO_SECONDS", 1, 14400
            )
        if overrides:
            for key, value in overrides.items():
                if value is not None:
                    values[key] = value
        return cls(**values)
