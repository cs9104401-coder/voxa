"""Localhost HTTP service for the optional ASR backends.

The Electron main process starts this service lazily and only when a
non-Whisper engine is selected. It binds to localhost, uses an optional bearer
token, and never exposes a file-path transcription endpoint.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .audio import MAX_AUDIO_BYTES
from .config import ASRConfig, DEVICES
from .device import describe as describe_device
from .errors import (
    ASRError,
    AudioInputError,
    BackendUnavailableError,
    CancellationError,
    DeviceUnavailableError,
    ModelDownloadError,
    ModelLoadError,
    OutOfMemoryError,
    UnsupportedLanguageError,
    UnsupportedModelError,
)
from .manager import ASRManager
from .registry import get_spec

LOGGER = logging.getLogger("voxa.asr.service")
SERVICE_VERSION = "2.0"
READ_CHUNK = 1024 * 1024


class LoadRequest(BaseModel):
    model: str | None = None
    device: str | None = None
    compute_type: str | None = None
    language: str | None = None


class DownloadRequest(BaseModel):
    model: str | None = None


def _validate_text(value: str | None, field: str, maximum: int = 200) -> None:
    if value is None:
        return
    text = str(value).strip()
    if len(text) > maximum or any(char in text for char in "\r\n"):
        raise ASRError(f"{field} must be a single line of at most {maximum} characters.")


def _validate_device(device: str | None) -> None:
    if device is None:
        return
    if str(device).lower() not in DEVICES:
        raise ASRError(f"device must be one of {', '.join(DEVICES)}.")


def _validate_compute_type(compute_type: str | None) -> None:
    if compute_type is None:
        return
    text = str(compute_type).strip().lower()
    if text and (len(text) > 40 or not all(char.isalnum() or char == "_" for char in text)):
        raise ASRError("compute_type must contain only letters, digits, and underscores.")


def _read_upload(upload: UploadFile) -> bytes:
    if upload is None:
        raise AudioInputError("Upload an audio file in the 'audio' field.")
    pieces: list[bytes] = []
    total = 0
    while True:
        chunk = upload.file.read(READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_AUDIO_BYTES:
            raise AudioInputError("The uploaded audio is larger than the 512 MB safety limit.")
        pieces.append(chunk)
    data = b"".join(pieces)
    if not data:
        raise AudioInputError("The uploaded audio file is empty.")
    return data


def _status_code(error: ASRError) -> int:
    if isinstance(error, CancellationError):
        return 409
    if isinstance(error, (UnsupportedModelError, UnsupportedLanguageError, AudioInputError)):
        return 422
    if isinstance(error, (BackendUnavailableError, DeviceUnavailableError)):
        return 409
    if isinstance(error, OutOfMemoryError):
        return 507
    if isinstance(error, ModelDownloadError):
        return 502
    if isinstance(error, ModelLoadError):
        return 500
    return 400


def create_app(
    config: ASRConfig,
    manager: ASRManager | None = None,
    *,
    started_at: float | None = None,
) -> FastAPI:
    active_manager = manager or ASRManager(
        config,
        compatibility_cache_dirs=(
            os.getenv("VOXA_WHISPER_CACHE", ""),
            os.getenv("VOXA_ASR_COMPAT_CACHE", ""),
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
            try:
                active_manager.shutdown()
            except Exception:  # noqa: BLE001 - shutdown must not mask the exit path
                LOGGER.debug("ASR manager shutdown failed", exc_info=True)

    app = FastAPI(
        title="Voxa ASR service",
        version=SERVICE_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.manager = active_manager
    app.state.started_at = started_at if started_at is not None else time.monotonic()
    app.state.transcribe_lock = threading.Lock()
    app.state.active_cancel = None

    @app.middleware("http")
    async def guard(request: Request, call_next):
        token = app.state.config.service_token
        if token:
            header = request.headers.get("authorization", "")
            supplied = header[7:].strip() if header.lower().startswith("bearer ") else ""
            if not supplied:
                supplied = request.headers.get("x-voxa-asr-token", "").strip()
            if not supplied or not secrets.compare_digest(supplied, token):
                return JSONResponse(
                    status_code=401,
                    content={"ok": False, "error": {"code": "unauthorized", "message": "A valid ASR service token is required."}},
                )
        try:
            length = int(request.headers.get("content-length", "0") or "0")
        except ValueError:
            length = 0
        if length > MAX_AUDIO_BYTES + 1024 * 1024:
            return JSONResponse(
                status_code=413,
                content={"ok": False, "error": {"code": "audio_input_error", "message": "The request is too large."}},
            )
        return await call_next(request)

    @app.exception_handler(ASRError)
    async def asr_error_handler(_request: Request, error: ASRError):
        return JSONResponse(
            status_code=_status_code(error),
            content={"ok": False, "error": error.to_dict()},
        )

    @app.exception_handler(Exception)
    async def unexpected_error_handler(_request: Request, error: Exception):
        LOGGER.exception("Unhandled ASR service error")
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": {
                    "code": "asr_error",
                    "message": "The ASR service hit an unexpected error. Check the service log.",
                },
            },
        )

    @app.get("/")
    def root():
        return {"ok": True, "service": "voxa-asr", "version": SERVICE_VERSION}

    @app.get("/health")
    def health():
        status = app.state.manager.status()
        return {
            "ok": True,
            "service": "asr",
            "version": SERVICE_VERSION,
            "pid": os.getpid(),
            "uptime_seconds": round(time.monotonic() - app.state.started_at, 3),
            "config": app.state.config.as_public_dict(),
            "device": describe_device(app.state.config.device),
            "status": status,
        }

    @app.get("/status")
    def status():
        return {"ok": True, **app.state.manager.status()}

    @app.get("/models")
    def models():
        return {"ok": True, "models": app.state.manager.list_models(), "status": app.state.manager.status()}

    @app.post("/models/load", status_code=202)
    def load(payload: LoadRequest):
        model = payload.model or app.state.config.model
        _validate_text(model, "model")
        _validate_device(payload.device)
        _validate_compute_type(payload.compute_type)
        _validate_text(payload.language, "language", maximum=40)
        spec = get_spec(model)
        result = app.state.manager.request_load(
            spec.id,
            device=payload.device,
            compute_type=payload.compute_type,
            language=payload.language,
        )
        return {"ok": True, "status": result}

    @app.post("/models/download", status_code=202)
    def download(payload: DownloadRequest):
        model = payload.model or app.state.config.model
        _validate_text(model, "model")
        spec = get_spec(model)
        return {"ok": True, **app.state.manager.request_download(spec.id)}

    @app.post("/models/cancel")
    def cancel():
        return {"ok": True, "status": app.state.manager.cancel()}

    @app.post("/models/unload")
    def unload():
        return {"ok": True, "status": app.state.manager.unload()}

    @app.post("/transcribe")
    def transcribe(
        audio: UploadFile = File(...),
        model: str | None = Form(None),
        language: str | None = Form(None),
        word_timestamps: bool | None = Form(None),
        vad: bool | None = Form(None),
        timeout: float | None = Form(None),
    ):
        _validate_text(model, "model")
        _validate_text(language, "language", maximum=40)
        target = get_spec(model or app.state.config.model)
        data = _read_upload(audio)
        with app.state.transcribe_lock:
            if app.state.active_cancel is not None:
                raise ASRError("Another transcription is already running.")
            cancel_event = threading.Event()
            app.state.active_cancel = cancel_event
        try:
            result = app.state.manager.transcribe_bytes(
                data,
                model_id=target.id,
                language=language,
                word_timestamps=word_timestamps,
                vad=vad,
                cancel_event=cancel_event,
                timeout=timeout,
                # The HTTP service never loads or downloads implicitly. The app
                # checks the ready state, and a race must fail loudly instead of
                # pulling gigabytes during dictation. CLI auto-load is unchanged.
                auto_load=False,
                # The app sends the current language setting per request. Do not
                # fall back to the language captured when the service started,
                # or clearing the setting would keep using the old hint.
                use_config_language=False,
            )
        finally:
            with app.state.transcribe_lock:
                app.state.active_cancel = None
        return {"ok": True, "result": result.to_dict()}

    @app.post("/transcribe/cancel", status_code=202)
    def transcribe_cancel():
        with app.state.transcribe_lock:
            cancel_event = app.state.active_cancel
            if cancel_event is None:
                return {"ok": True, "canceled": False, "message": "No transcription is running."}
            cancel_event.set()
        return {"ok": True, "canceled": True}

    return app


def run_service(config: ASRConfig, *, host: str = "127.0.0.1", port: int = 8756) -> int:
    import uvicorn

    allowed = {"127.0.0.1", "localhost", "::1"}
    if str(host).strip().lower() not in allowed:
        raise ASRError("The ASR service binds to localhost only. Use 127.0.0.1, localhost, or ::1.")
    if not (1 <= int(port) <= 65535):
        raise ASRError("The ASR service port must be between 1 and 65535.")
    if not config.service_token:
        LOGGER.warning("ASR service is running without a token; only localhost clients can connect.")
    app = create_app(config)
    LOGGER.info("ASR service listening on http://%s:%s (pid %s)", host, port, os.getpid())
    uvicorn.run(
        app,
        host=host,
        port=int(port),
        log_level=str(config.log_level).lower(),
        access_log=False,
        log_config=None,
    )
    return 0
