"""Thread-safe model lifecycle and transcription orchestration.

The manager owns one active backend at a time. Loading runs on a worker thread
so HTTP health checks and cancellation stay responsive while a multi-gigabyte
model downloads. Inference is serialized; adapters that cannot consume
long-form audio are fed fixed-size chunks from :mod:`asr.audio`.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .audio import DecodedAudio, chunk_audio, decode_audio
from .config import ASRConfig
from .device import describe as describe_device
from .errors import (
    ASRError,
    CancellationError,
    ModelLoadError,
    OutOfMemoryError,
    UnsupportedModelError,
    map_exception,
)
from .model_downloads import ModelStore
from .registry import (
    ModelSpec,
    availability,
    create_backend,
    get_spec,
    list_specs,
)
from .schemas import Segment, Timings, Token, TranscriptionResult, Word

LOGGER = logging.getLogger("voxa.asr.manager")
POLL_SECONDS = 0.1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ASRManager:
    """Runtime model selection, loading, cancellation, and inference."""

    def __init__(
        self,
        config: ASRConfig,
        *,
        compatibility_cache_dirs: tuple[str, ...] = (),
        store: ModelStore | None = None,
    ) -> None:
        self.config = config
        self._selected_model = config.model
        self._store = store or ModelStore(
            config.cache_dir,
            offline=config.offline,
            compatibility_cache_dirs=compatibility_cache_dirs,
            progress=self._on_download,
        )
        self._lock = threading.RLock()
        self._inference_lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._backend: Any = None
        self._active_model: str | None = None
        self._target_model: str | None = None
        self._cancel_event: threading.Event | None = None
        self._thread: threading.Thread | None = None
        self._generation = 0
        self._loading = False
        self._last_load_seconds: float | None = None
        self._download_thread: threading.Thread | None = None
        self._download_cancel: threading.Event | None = None
        self._download_model: str | None = None
        self._download_error = ""
        self._state: dict[str, Any] = {
            "status": "idle",
            "model": self._selected_model,
            "target_model": self._selected_model,
            "error": "",
            "warnings": [],
            "progress": self._store.status(),
            "loaded_at": None,
        }

    # ------------------------------------------------------------------ state
    @property
    def store(self) -> ModelStore:
        return self._store

    def _spec_or_none(self, model_id: str | None) -> ModelSpec | None:
        try:
            return get_spec(model_id or self._selected_model)
        except ASRError:
            return None

    def _backend_capabilities(self) -> dict[str, bool]:
        backend = self._backend
        if backend is not None:
            return backend.capabilities()
        spec = self._spec_or_none(self._target_model or self._selected_model)
        if spec is None:
            return {}
        return dict(spec.capabilities)

    def _downloaded(self, spec: ModelSpec | None) -> bool:
        if spec is None:
            return False
        try:
            return self._store.existing_path(spec) is not None
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        # Read the download state before taking the manager lock. The store
        # invokes _on_download from its worker thread, which needs this lock;
        # taking the store lock while holding it would invert the lock order.
        progress = dict(self._store.status())
        with self._lock:
            state = dict(self._state)
            state["warnings"] = list(self._state.get("warnings") or [])
            state["progress"] = progress
        spec = self._spec_or_none(state.get("target_model") or self._selected_model)
        backend = self._backend
        availability_info = availability(spec) if spec else {"available": False, "missing": [], "outdated": [], "reason": "No model selected."}
        capabilities = backend.capabilities() if backend is not None else (dict(spec.capabilities) if spec else {})
        download_thread = self._download_thread
        return {
            "ok": state["status"] == "ready" and backend is not None,
            "service": "asr",
            "status": state["status"],
            "model": state.get("model") or self._selected_model,
            "active_model": self._active_model,
            "target_model": state.get("target_model") or self._selected_model,
            "selected_model": self._selected_model,
            "label": spec.label if spec else "",
            "backend": spec.backend if spec else "",
            "requested_device": self.config.device,
            "device": backend.effective_device if backend is not None else self.config.device,
            "compute_type": backend.effective_compute_type if backend is not None else (self.config.compute_type or "auto"),
            "cuda": describe_device(self.config.device),
            "languages": list(spec.languages) if spec else [],
            "capabilities": capabilities,
            "available": bool(availability_info.get("available")),
            "missing": list(availability_info.get("missing") or []),
            "outdated": list(availability_info.get("outdated") or []),
            "availability_reason": str(availability_info.get("reason") or ""),
            "downloaded": self._downloaded(spec),
            "cache_dir": str(self._store.cache_dir),
            "error": state.get("error", ""),
            "warnings": state["warnings"],
            "progress": state["progress"],
            "download_active": bool(download_thread is not None and download_thread.is_alive()),
            "download_model": self._download_model,
            "download_error": self._download_error,
            "load_seconds": self._last_load_seconds,
            "loaded_at": state.get("loaded_at"),
            "chunked": bool(spec and _needs_chunking(spec)),
            "chunk_seconds": float(self.config.chunk_seconds),
            "offline": bool(self.config.offline),
        }

    def list_models(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for spec in list_specs():
            info = availability(spec)
            row = spec.public()
            row.update(
                {
                    "available": bool(info["available"]),
                    "missing": list(info["missing"]),
                    "outdated": list(info["outdated"]),
                    "availability_reason": str(info.get("reason") or ""),
                    "downloaded": self._downloaded(spec),
                    "active": bool(self._active_model == spec.id),
                    "selected": bool(self._selected_model == spec.id),
                }
            )
            rows.append(row)
        return rows

    # -------------------------------------------------------------- lifecycle
    def _set(self, **updates: Any) -> None:
        with self._lock:
            self._state.update(updates)

    def _on_download(self, payload: dict[str, Any]) -> None:
        with self._lock:
            self._state["progress"] = dict(payload)
            progress_model = str(payload.get("model") or "")
            # A load owns the state while it runs. A standalone download owns
            # it only while its own worker is alive; otherwise late progress
            # from a finished job could overwrite idle/ready.
            standalone = (
                self._download_model is not None
                and self._download_thread is not None
                and self._download_thread.is_alive()
                and (not progress_model or progress_model == self._download_model)
            )
            if not self._loading and not standalone:
                return
            if self._loading:
                target = self._target_model
                if progress_model and target and progress_model != target:
                    return
            elif progress_model and progress_model != self._download_model:
                return
            if standalone and self._download_cancel is not None and self._download_cancel.is_set():
                return
            progress_status = str(payload.get("status") or "")
            if progress_status in {"preparing", "downloading"}:
                self._state["status"] = "downloading"
                if standalone:
                    self._state["model"] = progress_model or self._download_model
                    self._state["target_model"] = progress_model or self._download_model
                self._state["error"] = ""
            elif (
                progress_status == "complete"
                and self._loading
                and self._state.get("status") == "downloading"
            ):
                self._state["status"] = "loading"

    def _resolve_load_config(self, device: str | None, compute_type: str | None, language: str | None) -> ASRConfig:
        config = self.config
        if device is not None or compute_type is not None or language is not None:
            config = replace(
                config,
                device=device if device is not None else config.device,
                compute_type=compute_type if compute_type is not None else config.compute_type,
                language=language if language is not None else config.language,
            )
            config.validate()
        return config

    def request_load(
        self,
        model_id: str | None = None,
        *,
        device: str | None = None,
        compute_type: str | None = None,
        language: str | None = None,
    ) -> dict[str, Any]:
        """Validate and start a background load. Returns immediately."""
        spec = get_spec(model_id or self._selected_model)
        self._selected_model = spec.id
        info = availability(spec)
        if not info["available"]:
            message = (
                f"{spec.label} is not installed in this Python environment ({info.get('reason') or 'missing dependencies'}). "
                "Install the optional requirements file for this backend and restart the ASR service."
            )
            with self._lock:
                self._state.update(
                    {
                        "status": "error",
                        "model": spec.id,
                        "target_model": spec.id,
                        "error": message,
                        "warnings": [],
                    }
                )
            raise ModelLoadError(message)
        load_config = self._resolve_load_config(device, compute_type, language)
        with self._lock:
            if self._backend is not None and self._active_model == spec.id and self._state.get("status") == "ready":
                self._state.update({"model": spec.id, "target_model": spec.id, "error": ""})
                return self.status()
            current = self._thread
            if current is not None and current.is_alive() and self._target_model == spec.id and self._state.get("status") in {
                "preparing",
                "downloading",
                "loading",
            }:
                return self.status()
            self._generation += 1
            generation = self._generation
            if self._cancel_event is not None:
                self._cancel_event.set()
            cancel_event = threading.Event()
            self._cancel_event = cancel_event
            self._target_model = spec.id
            self._loading = True
            self._state.update(
                {
                    "status": "preparing",
                    "model": spec.id,
                    "target_model": spec.id,
                    "error": "",
                    "warnings": [],
                    "loaded_at": None,
                }
            )
            thread = threading.Thread(
                target=self._load_worker,
                args=(spec, load_config, generation, cancel_event),
                name=f"voxa-asr-load-{spec.id}",
                daemon=True,
            )
            self._thread = thread
            thread.start()
        return self.status()

    def _load_worker(
        self,
        spec: ModelSpec,
        base_config: ASRConfig,
        generation: int,
        cancel_event: threading.Event,
    ) -> None:
        attempts = 0
        config = base_config
        extra_warnings: list[str] = []
        while True:
            attempts += 1
            backend = None
            try:
                self._set(status="loading", error="")
                self._check_generation(generation, cancel_event)
                backend = create_backend(spec, config, self._store)
                backend.warnings.extend(extra_warnings)
                backend.load(cancel_event=cancel_event)
                self._check_generation(generation, cancel_event)
                with self._inference_lock:
                    old = self._backend
                    self._backend = backend
                    self._active_model = spec.id
                    self._last_load_seconds = backend.load_seconds
                    backend = None  # ownership transferred
                if old is not None:
                    try:
                        old.close()
                    except Exception:
                        LOGGER.debug("Old ASR backend did not unload cleanly", exc_info=True)
                with self._lock:
                    self._loading = False
                    self._state.update(
                        {
                            "status": "ready",
                            "model": spec.id,
                            "target_model": spec.id,
                            "error": "",
                            "warnings": list(extra_warnings),
                            "loaded_at": _now(),
                        }
                    )
                LOGGER.info(
                    "ASR model ready: %s on %s (%s)",
                    spec.id,
                    self._backend.effective_device,
                    self._backend.effective_compute_type,
                )
                return
            except CancellationError:
                if backend is not None:
                    try:
                        backend.close()
                    except Exception:
                        pass
                with self._lock:
                    if generation == self._generation:
                        self._loading = False
                        self._state.update({"status": "canceled", "error": "The ASR model load was canceled."})
                return
            except OutOfMemoryError as exc:
                if backend is not None:
                    try:
                        backend.close()
                    except Exception:
                        pass
                explicit_cuda = str(config.device).lower() == "cuda"
                if attempts == 1 and not explicit_cuda and config.allow_cpu_fallback:
                    extra_warnings = [
                        *extra_warnings,
                        f"{spec.label} ran out of memory on CUDA; retrying on CPU. {exc}",
                    ]
                    LOGGER.warning("ASR load ran out of GPU memory; retrying on CPU.")
                    config = replace(config, device="cpu", compute_type="int8")
                    continue
                self._fail(generation, exc)
                return
            except BaseException as exc:  # noqa: BLE001 - report every adapter failure
                if backend is not None:
                    try:
                        backend.close()
                    except Exception:
                        pass
                if cancel_event.is_set():
                    with self._lock:
                        if generation == self._generation:
                            self._loading = False
                            self._state.update({"status": "canceled", "error": "The ASR model load was canceled."})
                    return
                self._fail(generation, map_exception(exc, context=f"Loading {spec.label}"))
                return

    def _check_generation(self, generation: int, cancel_event: threading.Event) -> None:
        if cancel_event.is_set() or generation != self._generation:
            raise CancellationError("The ASR model load was canceled.")

    def _fail(self, generation: int, error: ASRError) -> None:
        message = error.message
        with self._lock:
            if generation != self._generation:
                return
            self._loading = False
            self._state.update({"status": "error", "error": message})
        LOGGER.error("ASR model load failed: %s", message)

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            self._generation += 1
            if self._cancel_event is not None:
                self._cancel_event.set()
            if self._download_cancel is not None:
                self._download_cancel.set()
            self._loading = False
            if self._state.get("status") in {"preparing", "downloading", "loading"}:
                self._state.update({"status": "canceled", "error": "The ASR model load was canceled."})
        return self.status()

    def unload(self) -> dict[str, Any]:
        self.cancel()
        with self._inference_lock:
            backend = self._backend
            self._backend = None
            self._active_model = None
        if backend is not None:
            try:
                backend.close()
            except Exception:
                LOGGER.debug("ASR backend did not unload cleanly", exc_info=True)
        with self._lock:
            self._loading = False
            self._last_load_seconds = None
            self._state.update(
                {
                    "status": "idle",
                    "model": self._selected_model,
                    "target_model": self._selected_model,
                    "error": "",
                    "warnings": [],
                    "loaded_at": None,
                }
            )
        return self.status()

    def shutdown(self) -> None:
        try:
            self.cancel()
        finally:
            with self._inference_lock:
                backend = self._backend
                self._backend = None
                self._active_model = None
                self._loading = False
            if backend is not None:
                try:
                    backend.close()
                except Exception:
                    pass
            for thread in (self._thread, self._download_thread):
                if thread is not None and thread.is_alive():
                    thread.join(timeout=2.0)

    # ------------------------------------------------------------------- wait
    def wait_until_ready(
        self,
        model_id: str | None = None,
        *,
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> None:
        spec = get_spec(model_id or self._selected_model)
        deadline = None if timeout is None else time.monotonic() + max(0.1, float(timeout))
        started = False
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise CancellationError("The transcription was canceled.")
            if not started:
                with self._lock:
                    ready = self._backend is not None and self._active_model == spec.id and self._state.get("status") == "ready"
                    matching_load = self._target_model == spec.id and self._state.get("status") in {
                        "preparing",
                        "downloading",
                        "loading",
                    }
                if not ready and not matching_load:
                    self.request_load(spec.id)
                started = True
            with self._lock:
                status = self._state.get("status")
                target = self._target_model
                active = self._active_model
                error = self._state.get("error") or ""
            if active == spec.id and status == "ready" and self._backend is not None:
                return
            if status == "canceled" and target == spec.id:
                raise CancellationError(error or "The ASR model load was canceled.")
            if status == "error" and target == spec.id:
                raise ModelLoadError(error or f"{spec.label} failed to load.")
            if deadline is not None and time.monotonic() > deadline:
                raise ModelLoadError(
                    f"{spec.label} is still {status or 'loading'}. Follow download progress in the ASR status."
                )
            time.sleep(POLL_SECONDS)

    # -------------------------------------------------------------- inference
    def transcribe_file(
        self,
        path: str | os.PathLike[str],
        *,
        model_id: str | None = None,
        language: str | None = None,
        word_timestamps: bool | None = None,
        vad: bool | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
    ) -> TranscriptionResult:
        audio = decode_audio(path, self.config.sample_rate)
        return self.transcribe_audio(
            audio.audio,
            audio.sample_rate,
            model_id=model_id,
            language=language,
            word_timestamps=word_timestamps,
            vad=vad,
            cancel_event=cancel_event,
            timeout=timeout,
            decoded=audio,
        )

    def transcribe_bytes(
        self,
        data: bytes,
        *,
        model_id: str | None = None,
        language: str | None = None,
        word_timestamps: bool | None = None,
        vad: bool | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
        auto_load: bool = True,
        use_config_language: bool = True,
    ) -> TranscriptionResult:
        audio = decode_audio(data, self.config.sample_rate)
        return self.transcribe_audio(
            audio.audio,
            audio.sample_rate,
            model_id=model_id,
            language=language,
            word_timestamps=word_timestamps,
            vad=vad,
            cancel_event=cancel_event,
            timeout=timeout,
            decoded=audio,
            auto_load=auto_load,
            use_config_language=use_config_language,
        )

    def transcribe_audio(
        self,
        audio: np.ndarray,
        sample_rate: int,
        *,
        model_id: str | None = None,
        language: str | None = None,
        word_timestamps: bool | None = None,
        vad: bool | None = None,
        cancel_event: threading.Event | None = None,
        timeout: float | None = None,
        decoded: DecodedAudio | None = None,
        auto_load: bool = True,
        use_config_language: bool = True,
    ) -> TranscriptionResult:
        data = np.asarray(audio, dtype=np.float32).reshape(-1)
        if data.size == 0:
            raise ASRError("Audio is empty.")
        if not np.all(np.isfinite(data)):
            raise ASRError("Audio contains non-finite samples.")
        if int(sample_rate) != int(self.config.sample_rate):
            raise ASRError(
                f"ASR expects {self.config.sample_rate} Hz mono audio but received {sample_rate} Hz."
            )
        target = get_spec(model_id or self._selected_model)
        already_loaded = self._backend is not None and self._active_model == target.id
        if auto_load and not already_loaded:
            self.wait_until_ready(target.id, timeout=timeout, cancel_event=cancel_event)
        with self._inference_lock:
            backend = self._backend
            if backend is None or self._active_model != target.id:
                raise ModelLoadError(f"{target.label} is not loaded.")
            started = time.monotonic()
            effective_language = language
            if effective_language is None and use_config_language:
                effective_language = self.config.language
            want_words = self.config.word_timestamps if word_timestamps is None else bool(word_timestamps)
            use_vad = self.config.vad if vad is None else bool(vad)
            if cancel_event is not None and cancel_event.is_set():
                raise CancellationError("The transcription was canceled.")
            duration = float(data.size) / float(sample_rate) if decoded is None else float(decoded.duration_seconds)
            if duration > float(self.config.max_audio_seconds):
                raise ASRError(
                    f"Audio is {duration:.1f}s, longer than the configured limit of "
                    f"{self.config.max_audio_seconds:.0f}s.",
                    details={"audio_seconds": round(duration, 3), "max_audio_seconds": self.config.max_audio_seconds},
                )
            chunk_seconds = float(self.config.chunk_seconds)
            if duration <= chunk_seconds or not _needs_chunking(target):
                result = backend.transcribe(
                    data,
                    sample_rate,
                    language=effective_language,
                    word_timestamps=want_words,
                    vad=use_vad,
                    cancel_event=cancel_event,
                )
                result.duration_seconds = result.duration_seconds or duration
                metadata = dict(result.metadata or {})
                metadata["chunked"] = False
                result.metadata = metadata
            else:
                result = self._transcribe_chunked(
                    backend,
                    data,
                    sample_rate,
                    duration,
                    chunk_seconds,
                    effective_language,
                    want_words,
                    use_vad,
                    cancel_event,
                )
            infer_seconds = round(max(0.0, time.monotonic() - started), 4)
            load_seconds = 0.0 if already_loaded else self._last_load_seconds
            total = infer_seconds + float(load_seconds or 0.0)
            result.timings = Timings(
                audio_seconds=round(duration, 4),
                load_seconds=round(float(load_seconds), 4) if load_seconds is not None else None,
                inference_seconds=infer_seconds,
                total_seconds=round(total, 4),
                real_time_factor=round(infer_seconds / duration, 4) if duration > 0 else None,
            )
            metadata = dict(result.metadata or {})
            metadata["inference_seconds"] = infer_seconds
            result.metadata = metadata
            return result

    def _transcribe_chunked(
        self,
        backend: Any,
        audio: np.ndarray,
        sample_rate: int,
        duration: float,
        chunk_seconds: float,
        language: str | None,
        word_timestamps: bool,
        vad: bool,
        cancel_event: threading.Event | None,
    ) -> TranscriptionResult:
        pieces: list[str] = []
        segments: list[Segment] = []
        words: list[Word] = []
        tokens: list[Token] = []
        warnings: list[str] = []
        language_value: str | None = None
        language_probability: float | None = None
        chunks = list(chunk_audio(audio, sample_rate, chunk_seconds))
        for chunk in chunks:
            if cancel_event is not None and cancel_event.is_set():
                raise CancellationError("The transcription was canceled.")
            result = backend.transcribe(
                chunk.audio,
                sample_rate,
                language=language,
                word_timestamps=word_timestamps,
                vad=vad,
                cancel_event=cancel_event,
            )
            if result.text:
                pieces.append(result.text.strip())
            if language_value is None and result.language:
                language_value = result.language
                language_probability = result.language_probability
            for item in result.segments or []:
                segments.append(
                    Segment(
                        text=item.text,
                        start=_offset(item.start, chunk.start),
                        end=_offset(item.end, chunk.start),
                        confidence=item.confidence,
                    )
                )
            for item in result.words or []:
                words.append(
                    Word(
                        text=item.text,
                        start=_offset(item.start, chunk.start),
                        end=_offset(item.end, chunk.start),
                        confidence=item.confidence,
                    )
                )
            for item in result.tokens or []:
                tokens.append(
                    Token(
                        text=item.text,
                        start=_offset(item.start, chunk.start),
                        end=_offset(item.end, chunk.start),
                    )
                )
            warnings.extend(result.warnings)
        text = " ".join(pieces).strip()
        if not text:
            raise ASRError("The model returned an empty transcript.")
        return backend._result(
            text=text,
            language=language_value,
            language_probability=language_probability,
            segments=segments or None,
            words=(words or None) if word_timestamps else None,
            tokens=tokens or None,
            duration_seconds=duration,
            warnings=[
                *warnings,
                f"Audio was processed in {len(chunks)} chunks of up to {chunk_seconds:g} seconds; "
                "this backend has no native long-form streaming mode.",
            ],
            metadata={
                "chunked": True,
                "chunks": len(chunks),
                "chunk_seconds": chunk_seconds,
            },
        )

    # ------------------------------------------------------------------ cache
    def request_download(self, model_id: str | None = None) -> dict[str, Any]:
        """Start an explicit download without loading the model."""
        spec = get_spec(model_id or self._selected_model)
        existing = self._store.existing_path(spec)
        if existing is not None:
            return {
                "ok": True,
                "model": spec.id,
                "status": "complete",
                "path": str(existing),
                "progress": self._store.status(),
            }
        with self._lock:
            thread = self._download_thread
            active = thread is not None and thread.is_alive()
            if active:
                if self._download_model != spec.id:
                    raise ASRError(
                        f"{self._download_model} is already downloading. Cancel it before starting {spec.label}."
                    )
            else:
                if self._loading:
                    raise ASRError("A model is already loading. Wait or cancel it before starting a download.")
                cancel_event = threading.Event()
                self._download_cancel = cancel_event
                self._download_model = spec.id
                self._target_model = spec.id
                self._download_error = ""
                self._state.update(
                    {
                        "status": "downloading",
                        "model": spec.id,
                        "target_model": spec.id,
                        "error": "",
                        "warnings": [],
                    }
                )
                thread = threading.Thread(
                    target=self._download_worker,
                    args=(spec, cancel_event),
                    name=f"voxa-asr-download-{spec.id}",
                    daemon=True,
                )
                self._download_thread = thread
                thread.start()
        # Snapshot progress after releasing the manager lock: the downloader
        # may already be reporting progress and needs this lock to publish it.
        progress = self._store.status()
        with self._lock:
            state_status = str(self._state.get("status") or "downloading")
        return {
            "ok": True,
            "model": spec.id,
            "status": state_status,
            "progress": progress,
        }

    def _download_worker(self, spec: ModelSpec, cancel_event: threading.Event) -> None:
        error = ""
        canceled = False
        try:
            self._store.resolve(spec, cancel_event)
        except CancellationError:
            canceled = True
        except ASRError as exc:
            error = exc.message
            LOGGER.error("ASR model download failed: %s", exc.message)
        except Exception as exc:  # noqa: BLE001 - background jobs must not crash the service
            error = map_exception(exc, context=f"Downloading {spec.label}").message
            LOGGER.exception("ASR model download failed")
        finally:
            with self._lock:
                owns_state = self._download_thread is threading.current_thread()
                if owns_state:
                    self._download_thread = None
                self._download_error = error
                # Finalize only if this worker still owns the visible state. A
                # concurrent load or a user-triggered unload wins over a late
                # terminal event from the downloader.
                if owns_state and not self._loading and self._target_model == spec.id:
                    current = self._state.get("status")
                    if current in {"preparing", "downloading", "canceled"}:
                        if error:
                            self._state.update({"status": "error", "error": error})
                        elif canceled:
                            self._state.update(
                                {"status": "canceled", "error": "The model download was canceled."}
                            )
                        else:
                            self._state.update({"status": "idle", "error": ""})

    def prefetch(
        self,
        model_id: str | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> Path:
        spec = get_spec(model_id or self._selected_model)
        with self._load_lock:
            existing = self._store.existing_path(spec)
            if existing is not None:
                return existing
            return self._store.resolve(spec, cancel_event)

    def describe(self) -> dict[str, Any]:
        return {
            "cache_dir": str(self._store.cache_dir),
            "offline": bool(self.config.offline),
            "config": self.config.as_public_dict(),
            "device": describe_device(self.config.device),
            "models": self.list_models(),
            "status": self.status(),
        }


def _needs_chunking(spec: ModelSpec) -> bool:
    # faster-whisper performs its own long-form sliding-window decoding, and
    # Qwen3-ASR chunks long audio internally. Parakeet/Granite are fed fixed
    # windows so a multi-hour file cannot exhaust memory in one forward pass.
    return spec.backend != "faster-whisper" and not spec.long_form


def _offset(value: float | None, base: float) -> float | None:
    if value is None:
        return None
    return round(float(value) + float(base), 3)
