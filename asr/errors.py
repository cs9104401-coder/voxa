"""Structured ASR exceptions shared by the CLI, server, and adapters."""

from __future__ import annotations


class ASRError(Exception):
    """Base class for every recoverable ASR failure."""

    code = "asr_error"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = str(message)
        self.details = dict(details or {})

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, **self.details}


class UnsupportedModelError(ASRError):
    code = "unsupported_model"


class BackendUnavailableError(ASRError):
    code = "backend_unavailable"


class ModelDownloadError(ASRError):
    code = "model_download_failed"


class UnsupportedLanguageError(ASRError):
    code = "unsupported_language"


class ModelLoadError(ASRError):
    code = "model_load_failed"


class AudioInputError(ASRError):
    code = "audio_input_error"


class DeviceUnavailableError(ASRError):
    code = "device_unavailable"


class TranscriptionError(ASRError):
    code = "transcription_failed"


class OutOfMemoryError(ASRError):
    code = "out_of_memory"


class StreamError(ASRError):
    code = "stream_error"


class CancellationError(ASRError):
    code = "cancelled"


OOM_MARKERS = (
    "out of memory",
    "outofmemory",
    "cudaerrormemoryallocation",
    "cuda error: out of memory",
    "insufficient memory",
    "not enough memory",
    "allocation failed",
    "cublas_status_alloc_failed",
    "cuda_error_out_of_memory",
)


def is_out_of_memory(exc: BaseException) -> bool:
    text = f"{exc.__class__.__name__}: {exc}".lower()
    return any(marker in text for marker in OOM_MARKERS)


def map_exception(exc: BaseException, *, context: str = "ASR") -> ASRError:
    """Convert an arbitrary adapter failure into a stable ASR error."""
    if isinstance(exc, ASRError):
        return exc
    if is_out_of_memory(exc):
        return OutOfMemoryError(f"{context} ran out of memory: {exc}")
    return ASRError(f"{context} failed: {exc}")
