"""Serializable result types. Missing metadata stays ``None``; it is never invented."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Word:
    text: str
    start: float | None = None
    end: float | None = None
    confidence: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Token:
    """A sub-word token with timing.

    Parakeet's official Transformers path exposes token timestamps, not
    word-level timestamps. Keeping tokens separate from ``words`` avoids
    relabeling partial tokens as words.
    """

    text: str
    start: float | None = None
    end: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Segment:
    text: str
    start: float | None = None
    end: float | None = None
    confidence: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Timings:
    audio_seconds: float | None = None
    load_seconds: float | None = None
    decode_seconds: float | None = None
    inference_seconds: float | None = None
    total_seconds: float | None = None
    real_time_factor: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TranscriptionResult:
    text: str
    model_id: str
    backend: str
    device: str
    language: str | None = None
    language_probability: float | None = None
    segments: list[Segment] | None = None
    words: list[Word] | None = None
    tokens: list[Token] | None = None
    duration_seconds: float | None = None
    compute_type: str | None = None
    timings: Timings | None = None
    warnings: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "text": self.text,
            "language": self.language,
            "language_probability": self.language_probability,
            "segments": [item.to_dict() for item in self.segments] if self.segments is not None else None,
            "words": [item.to_dict() for item in self.words] if self.words is not None else None,
            "tokens": [item.to_dict() for item in self.tokens] if self.tokens is not None else None,
            "duration_seconds": self.duration_seconds,
            "model_id": self.model_id,
            "backend": self.backend,
            "device": self.device,
            "compute_type": self.compute_type,
            "timings": self.timings.to_dict() if self.timings else None,
            "warnings": list(self.warnings),
            "metadata": dict(self.metadata),
        }
        return payload
