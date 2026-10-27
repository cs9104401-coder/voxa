"""Voxa's modular, local-only speech recognition subsystem.

The package is intentionally light at import time. Heavy frameworks are only
imported by the individual backend after a model has been selected.
"""

from .errors import (
    ASRError,
    AudioInputError,
    BackendUnavailableError,
    CancellationError,
    DeviceUnavailableError,
    ModelDownloadError,
    ModelLoadError,
    OutOfMemoryError,
    StreamError,
    TranscriptionError,
    UnsupportedLanguageError,
    UnsupportedModelError,
)
from .schemas import Segment, Timings, Token, TranscriptionResult, Word
from .config import ASRConfig

__all__ = [
    "ASRError",
    "ASRConfig",
    "AudioInputError",
    "BackendUnavailableError",
    "CancellationError",
    "DeviceUnavailableError",
    "ModelDownloadError",
    "ModelLoadError",
    "OutOfMemoryError",
    "Segment",
    "StreamError",
    "Timings",
    "Token",
    "TranscriptionError",
    "TranscriptionResult",
    "UnsupportedLanguageError",
    "UnsupportedModelError",
    "Word",
]
