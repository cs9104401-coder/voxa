from __future__ import annotations

import argparse
import asyncio
import logging
import os
import threading
import time
import urllib.request


def configure_cache_dir() -> str:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--cache-dir", default=os.getenv("VOXA_WHISPER_CACHE", ""))
    options, _ = parser.parse_known_args()
    cache_dir = str(options.cache_dir or "").strip()
    if not cache_dir:
        return ""
    cache_dir = os.path.abspath(cache_dir)
    os.makedirs(cache_dir, exist_ok=True)
    os.environ["HF_HOME"] = cache_dir
    os.environ["HF_HUB_CACHE"] = os.path.join(cache_dir, "hub")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    return cache_dir


CACHE_DIR = configure_cache_dir()

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel
from huggingface_hub import HfApi, hf_hub_url
from huggingface_hub.constants import HF_HUB_CACHE

MAX_AUDIO_BYTES = 25 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
DOWNLOAD_STALL_SECONDS = 60
DOWNLOAD_SPEED_IDLE_SECONDS = 5
MODEL_SPECS: dict[str, dict[str, Any]] = {
    "tiny": {
        "label": "Tiny",
        "repo_id": "Systran/faster-whisper-tiny",
        "size_bytes": 75_525_797,
    },
    "base": {
        "label": "Base",
        "repo_id": "Systran/faster-whisper-base",
        "size_bytes": 145_466_455,
    },
    "small": {
        "label": "Small",
        "repo_id": "Systran/faster-whisper-small",
        "size_bytes": 484_190_939,
    },
    "medium": {
        "label": "Medium",
        "repo_id": "Systran/faster-whisper-medium",
        "size_bytes": 1_530_000_000,
    },
    "large-v3-turbo": {
        "label": "Large v3 Turbo",
        "repo_id": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        "size_bytes": 1_620_000_000,
    },
    "large-v3": {
        "label": "Large v3",
        "repo_id": "Systran/faster-whisper-large-v3",
        "size_bytes": 3_090_000_000,
    },
}
DOWNLOAD_ROOT = Path(HF_HUB_CACHE).parent / "models"
logger = logging.getLogger("voxa.whisper")


class DownloadCancelled(Exception):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local faster-whisper service for Voxa.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; localhost by default.")
    parser.add_argument("--port", type=int, default=int(os.getenv("WHISPER_PORT", "8000")))
    parser.add_argument("--model", default=os.getenv("WHISPER_MODEL", "small"))
    parser.add_argument("--device", default=os.getenv("WHISPER_DEVICE", "cpu"))
    parser.add_argument("--compute-type", default=os.getenv("WHISPER_COMPUTE_TYPE", ""))
    parser.add_argument("--cache-dir", default=os.getenv("VOXA_WHISPER_CACHE", ""))
    return parser.parse_args()


def compute_type_for(device: str, requested: str) -> str:
    if requested:
        return requested
    return "int8" if device == "cpu" else "float16"


def transcribe_bytes(model: WhisperModel, audio: bytes) -> str:
    segments, _info = model.transcribe(BytesIO(audio), beam_size=5, vad_filter=True)
    return "".join(segment.text for segment in segments).strip()


def allowed_model_file(filename: str) -> bool:
    if not filename or "/" in filename or "\\" in filename:
        return False
    return filename in {
        "config.json",
        "preprocessor_config.json",
        "model.bin",
        "tokenizer.json",
    } or filename.startswith("vocabulary.")


def model_directory(model: str) -> Path:
    return DOWNLOAD_ROOT / Path(model).name


def completed_bytes(path: Path) -> int:
    total = 0
    try:
        items = list(path.rglob("*"))
    except OSError:
        return 0
    for item in items:
        try:
            if item.is_file() and not item.name.endswith(".part"):
                total += item.stat().st_size
        except OSError:
            continue
    return total


def download_bytes(path: Path, generation: int) -> int:
    marker = f".{generation}-"
    total = 0
    try:
        items = list(path.rglob("*"))
    except OSError:
        return 0
    for item in items:
        try:
            if not item.is_file():
                continue
            if item.name.endswith(".part") and marker not in item.name:
                continue
            total += item.stat().st_size
        except OSError:
            continue
    return total


def hf_repo_directory(repo_id: str) -> Path:
    return Path(HF_HUB_CACHE) / f"models--{repo_id.replace('/', '--')}"


def model_snapshot_ready(local_path: str) -> bool:
    path = Path(local_path)
    try:
        required = ("config.json", "model.bin", "tokenizer.json")
        if not all((path / name).is_file() and (path / name).stat().st_size > 0 for name in required):
            return False
        return any(item.is_file() and item.stat().st_size > 0 and item.name.startswith("vocabulary.") for item in path.iterdir())
    except OSError:
        return False


def hf_snapshot_path(repo_id: str) -> Path | None:
    snapshots = hf_repo_directory(repo_id) / "snapshots"
    try:
        candidates = sorted((item for item in snapshots.iterdir() if item.is_dir()), reverse=True)
    except OSError:
        return None
    for snapshot in candidates:
        if model_snapshot_ready(str(snapshot)):
            return snapshot
    return None


def downloaded_model_path(model: str) -> str | None:
    if os.path.isdir(model):
        return model if model_snapshot_ready(model) else None
    spec = MODEL_SPECS.get(model)
    if not spec:
        return None
    local = model_directory(model)
    if model_snapshot_ready(str(local)):
        return str(local)
    cached = hf_snapshot_path(spec["repo_id"])
    return str(cached) if cached else None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def percent_for(downloaded: int, total: int) -> int | None:
    if total <= 0:
        return None
    return max(0, min(100, int(downloaded * 100 / total)))


def model_files(repo_id: str) -> list[tuple[str, int]]:
    info = HfApi().model_info(repo_id, files_metadata=True)
    files = []
    for sibling in info.siblings:
        filename = str(sibling.rfilename)
        if allowed_model_file(filename):
            files.append((filename, int(sibling.size or 0)))
    return files


def set_download(application: FastAPI, **updates: Any) -> dict[str, Any]:
    download = {
        **(getattr(application.state, "download", {}) or {}),
        **updates,
        "updated_at": now_iso(),
    }
    application.state.download = download
    return download


def download_file(
    repo_id: str,
    filename: str,
    destination: Path,
    cancel_event: threading.Event,
    generation: int,
    size: int = 0,
) -> None:
    url = hf_hub_url(repo_id, filename)
    request = urllib.request.Request(url, headers={"User-Agent": "Voxa-whisper/1.0"})
    part = destination.with_name(f"{destination.name}.{generation}-{time.time_ns()}.part")
    try:
        timeout = DOWNLOAD_STALL_SECONDS + 15
        with urllib.request.urlopen(request, timeout=timeout) as response, part.open("wb") as output:
            while True:
                if cancel_event.is_set():
                    raise DownloadCancelled()
                chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                if cancel_event.is_set():
                    raise DownloadCancelled()
                output.write(chunk)
        if cancel_event.is_set():
            raise DownloadCancelled()
        actual = part.stat().st_size
        if size > 0 and actual != size:
            raise RuntimeError(f"Downloaded {filename} is {actual} bytes, expected {size}.")
        os.replace(part, destination)
    except BaseException:
        try:
            part.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def cleanup_partial_downloads() -> None:
    if not DOWNLOAD_ROOT.is_dir():
        return
    for part in DOWNLOAD_ROOT.rglob("*.part"):
        try:
            part.unlink()
        except OSError:
            pass


def download_model_files(
    model: str,
    repo_id: str,
    files: list[tuple[str, int]],
    cancel_event: threading.Event,
    generation: int,
) -> str:
    target = model_directory(model)
    target.mkdir(parents=True, exist_ok=True)
    for filename, size in files:
        if cancel_event.is_set():
            raise DownloadCancelled()
        destination = target / Path(filename).name
        try:
            if destination.is_file() and (size <= 0 or destination.stat().st_size == size):
                continue
        except OSError:
            pass
        download_file(repo_id, filename, destination, cancel_event, generation, size)
    if not model_snapshot_ready(str(target)):
        raise RuntimeError(f"The downloaded Whisper model at {target} is incomplete.")
    return str(target)


async def download_model(
    application: FastAPI,
    model: str,
    cancel_event: threading.Event,
    generation: int,
) -> str:
    if cancel_event.is_set() or generation != application.state.switch_generation:
        raise DownloadCancelled()
    spec = MODEL_SPECS.get(model)
    if not spec:
        raise ValueError(f"Unknown Whisper model '{model}'.")
    target = model_directory(model)
    expected = int(spec.get("size_bytes") or 0)
    completed = completed_bytes(target)
    set_download(
        application,
        model=model,
        status="preparing",
        downloaded_bytes=completed,
        total_bytes=expected,
        percent=percent_for(completed, expected),
        speed_bps=0,
        stalled=False,
        error="",
        started_at=now_iso(),
    )
    files = await asyncio.to_thread(model_files, spec["repo_id"])
    if cancel_event.is_set() or generation != application.state.switch_generation:
        raise DownloadCancelled()
    if not files:
        raise RuntimeError(f"No downloadable files were found for the {model} model.")
    total = sum(size for _filename, size in files) or expected
    downloaded = completed_bytes(target)
    set_download(
        application,
        status="downloading",
        total_bytes=total,
        downloaded_bytes=downloaded,
        percent=percent_for(downloaded, total),
    )
    logger.info("Downloading %s (%s bytes) into %s", model, total, target)
    download_task = asyncio.create_task(
        asyncio.to_thread(download_model_files, model, spec["repo_id"], files, cancel_event, generation)
    )
    last_bytes = downloaded
    last_at = time.monotonic()
    last_progress_at = last_at
    speed = 0.0
    stalled = False
    try:
        while not download_task.done():
            await asyncio.sleep(0.5)
            current = download_bytes(target, generation)
            now = time.monotonic()
            elapsed = now - last_at
            if current > last_bytes and elapsed > 0:
                speed = (current - last_bytes) / elapsed
                last_progress_at = now
                stalled = False
            elif now - last_progress_at >= DOWNLOAD_STALL_SECONDS:
                speed = 0.0
                stalled = True
            elif now - last_progress_at >= DOWNLOAD_SPEED_IDLE_SECONDS:
                speed = 0.0
            last_bytes = current
            last_at = now
            set_download(
                application,
                status="downloading",
                downloaded_bytes=current,
                total_bytes=total,
                percent=percent_for(current, total),
                speed_bps=round(speed, 2),
                stalled=stalled,
            )
        result = await download_task
    except asyncio.CancelledError:
        cancel_event.set()
        download_task.cancel()
        if generation == application.state.switch_generation:
            set_download(application, status="canceled", speed_bps=0, stalled=False, error="The download was canceled.")
        raise
    except DownloadCancelled:
        if generation == application.state.switch_generation:
            set_download(application, status="canceled", speed_bps=0, stalled=False, error="The download was canceled.")
        raise
    except Exception as exc:
        if generation == application.state.switch_generation:
            set_download(application, status="error", speed_bps=0, stalled=False, error=str(exc) or exc.__class__.__name__)
        raise
    if cancel_event.is_set() or generation != application.state.switch_generation:
        raise DownloadCancelled()
    downloaded = completed_bytes(target)
    set_download(
        application,
        status="complete",
        downloaded_bytes=downloaded,
        total_bytes=max(total, downloaded),
        percent=100,
        speed_bps=0,
        stalled=False,
        error="",
    )
    logger.info("Whisper model download complete: %s", result)
    return result


async def switch_model_task(
    application: FastAPI,
    target: str,
    generation: int,
    cancel_event: threading.Event,
) -> None:
    try:
        if cancel_event.is_set() or generation != application.state.switch_generation:
            return
        application.state.switch = {
            "target": target,
            "status": "preparing",
            "error": "",
        }
        local_model = downloaded_model_path(target)
        if not local_model:
            application.state.switch = {
                "target": target,
                "status": "downloading",
                "error": "",
            }
            local_model = await download_model(application, target, cancel_event, generation)
        if cancel_event.is_set() or generation != application.state.switch_generation:
            raise DownloadCancelled()
        application.state.switch = {
            "target": target,
            "status": "loading",
            "error": "",
        }
        config = application.state.config
        logger.info(
            "Loading %s on %s (%s)",
            local_model,
            config["device"],
            config["compute_type"],
        )
        model = await asyncio.to_thread(
            WhisperModel,
            local_model,
            device=config["device"],
            compute_type=config["compute_type"],
        )
        if cancel_event.is_set() or generation != application.state.switch_generation:
            raise DownloadCancelled()
        application.state.model = model
        application.state.active_model = target
        application.state.config["model"] = target
        application.state.load_error = ""
        application.state.switch = {
            "target": target,
            "status": "complete",
            "error": "",
        }
        logger.info("Whisper model is ready: %s", target)
    except DownloadCancelled:
        if generation == application.state.switch_generation:
            application.state.switch = {
                "target": target,
                "status": "canceled",
                "error": "The model switch was canceled.",
            }
            if application.state.model is None:
                application.state.load_error = "The Whisper model load was canceled."
    except Exception as exc:
        if generation != application.state.switch_generation or cancel_event.is_set():
            return
        message = str(exc) or exc.__class__.__name__
        application.state.switch = {
            "target": target,
            "status": "error",
            "error": message,
        }
        if application.state.model is None:
            application.state.load_error = message
        logger.exception("Whisper model switch failed")


def request_switch(application: FastAPI, model: str) -> dict[str, Any]:
    if not os.path.isdir(model) and model not in MODEL_SPECS:
        raise ValueError(f"Unknown Whisper model '{model}'.")
    current_task = getattr(application.state, "switch_task", None)
    current_switch = getattr(application.state, "switch", {}) or {}
    download = getattr(application.state, "download", {}) or {}
    active_switch = current_switch.get("status") in {"preparing", "downloading", "loading"}
    stalled_download = current_switch.get("status") == "downloading" and bool(download.get("stalled"))
    if current_task and not current_task.done() and current_switch.get("target") == model and active_switch and not stalled_download:
        return current_switch
    if current_task and not current_task.done():
        current_task.cancel()
    previous_cancel = getattr(application.state, "cancel_event", None)
    if previous_cancel:
        previous_cancel.set()
    application.state.switch_generation = int(getattr(application.state, "switch_generation", 0)) + 1
    generation = application.state.switch_generation
    if application.state.model is not None and application.state.active_model == model:
        application.state.load_error = ""
        application.state.switch = {
            "target": model,
            "status": "complete",
            "error": "",
        }
        application.state.switch_task = None
        return application.state.switch
    cancel_event = threading.Event()
    application.state.cancel_event = cancel_event
    application.state.load_error = ""
    application.state.switch = {
        "target": model,
        "status": "preparing",
        "error": "",
    }
    set_download(
        application,
        model=model,
        status="preparing",
        downloaded_bytes=0,
        total_bytes=0,
        percent=None,
        speed_bps=0,
        stalled=False,
        error="",
        started_at=now_iso(),
    )
    application.state.switch_task = asyncio.create_task(
        switch_model_task(application, model, generation, cancel_event)
    )
    return application.state.switch


def cancel_switch(application: FastAPI, reason: str = "The model switch was canceled.") -> None:
    application.state.switch_generation = int(getattr(application.state, "switch_generation", 0)) + 1
    cancel_event = getattr(application.state, "cancel_event", None)
    if cancel_event:
        cancel_event.set()
    task = getattr(application.state, "switch_task", None)
    if task and not task.done():
        task.cancel()
    switch = getattr(application.state, "switch", {}) or {}
    if switch.get("status") in {"preparing", "downloading", "loading"}:
        application.state.switch = {
            **switch,
            "status": "canceled",
            "error": reason,
        }
    if application.state.model is None:
        application.state.load_error = reason
    download = getattr(application.state, "download", {}) or {}
    if download.get("status") in {"preparing", "downloading"}:
        set_download(application, status="canceled", speed_bps=0, stalled=False, error=reason)


def switching(application: FastAPI) -> bool:
    switch = getattr(application.state, "switch", {}) or {}
    return switch.get("status") in {"preparing", "downloading", "loading"}


def active_model(application: FastAPI) -> str:
    return application.state.active_model or application.state.config["model"]


def model_list(application: FastAPI) -> list[dict[str, Any]]:
    models = []
    for model, spec in MODEL_SPECS.items():
        is_active = application.state.model is not None and application.state.active_model == model
        downloaded = bool(downloaded_model_path(model))
        status = "Active" if is_active else ("Downloaded" if downloaded else "Not downloaded")
        models.append(
            {
                "id": model,
                "label": spec["label"],
                "size_bytes": int(spec.get("size_bytes") or 0),
                "downloaded": downloaded,
                "active": is_active,
                "status": status,
            }
        )
    return models


def download_payload(application: FastAPI) -> dict[str, Any]:
    download = getattr(application.state, "download", {}) or {}
    downloaded = int(download.get("downloaded_bytes") or 0)
    total = int(download.get("total_bytes") or 0)
    percent = download.get("percent")
    return {
        "model": download.get("model", ""),
        "status": download.get("status", "idle"),
        "downloaded_bytes": downloaded,
        "total_bytes": total,
        "percent": int(percent) if percent is not None else None,
        "speed_bps": float(download.get("speed_bps") or 0),
        "stalled": bool(download.get("stalled")),
        "error": download.get("error", ""),
        "started_at": download.get("started_at", ""),
        "updated_at": download.get("updated_at", ""),
    }


def service_state(application: FastAPI) -> dict[str, Any]:
    switch = getattr(application.state, "switch", {}) or {}
    active = active_model(application)
    is_switching = switching(application)
    return {
        "ok": application.state.model is not None,
        "active_model": application.state.active_model,
        "target_model": switch.get("target") or active,
        "model": active,
        "switching": is_switching,
        "switch_status": switch.get("status", ""),
        "switch_error": switch.get("error", ""),
        "download": download_payload(application),
        "models": model_list(application),
    }


def health_payload(application: FastAPI) -> dict[str, Any]:
    state = service_state(application)
    ready = application.state.model is not None
    switch = getattr(application.state, "switch", {}) or {}
    download = state["download"]
    if state["switching"]:
        status = "downloading" if switch.get("status") == "downloading" else "loading"
    elif ready:
        status = "ready"
    else:
        status = "error"

    progress = download
    percent = progress.get("percent")
    if status == "downloading":
        target = state["target_model"]
        if progress.get("stalled"):
            message = f"The {target} model download is stalled at {percent if percent is not None else 0}%. Retry or cancel."
        elif percent is not None:
            message = f"Downloading the {target} model ({percent}%)."
        else:
            message = f"Preparing the {target} model download."
        if ready and application.state.active_model:
            message += f" The {application.state.active_model} model remains active."
    elif status == "loading":
        target = state["target_model"]
        message = f"Loading the {target} model."
        if ready and application.state.active_model:
            message += f" The {application.state.active_model} model remains active."
    elif status == "ready":
        message = f"The {active_model(application)} model is ready."
        if state.get("switch_error"):
            message += f" Could not switch to {state['target_model']}: {state['switch_error']}"
    else:
        message = application.state.load_error or state.get("switch_error") or "The Whisper model failed to load."

    payload: dict[str, Any] = {
        "ok": ready,
        "status": status,
        "model": state["model"],
        "target_model": state["target_model"],
        "active_model": state["active_model"],
        "device": application.state.config["device"],
        "compute_type": application.state.config["compute_type"],
        "cache_dir": application.state.config.get("cache_dir", ""),
        "message": message,
        "switching": state["switching"],
        "switch_status": state["switch_status"],
        "switch_error": state["switch_error"],
        "progress": progress,
        "models": state["models"],
    }
    if application.state.load_error:
        payload["error"] = application.state.load_error
    return payload


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.model = None
    application.state.active_model = None
    application.state.load_error = ""
    application.state.download = {
        "status": "idle",
        "downloaded_bytes": 0,
        "total_bytes": 0,
        "percent": None,
        "speed_bps": 0,
        "stalled": False,
        "error": "",
    }
    application.state.switch = {"target": application.state.config["model"], "status": "idle", "error": ""}
    application.state.switch_generation = 0
    application.state.switch_task = None
    application.state.cancel_event = threading.Event()
    application.state.transcribe_lock = asyncio.Lock()
    cleanup_partial_downloads()
    try:
        request_switch(application, application.state.config["model"])
    except Exception as exc:
        application.state.load_error = str(exc) or exc.__class__.__name__
    try:
        yield
    finally:
        cancel_switch(application, "Whisper is stopping.")
        task = getattr(application.state, "switch_task", None)
        if task and not task.done():
            task.cancel()
        application.state.model = None


app = FastAPI(title="Voxa Local Whisper", lifespan=lifespan)
app.state.config = {
    "model": os.getenv("WHISPER_MODEL", "small"),
    "device": os.getenv("WHISPER_DEVICE", "cpu"),
    "compute_type": compute_type_for(
        os.getenv("WHISPER_DEVICE", "cpu"),
        os.getenv("WHISPER_COMPUTE_TYPE", ""),
    ),
    "cache_dir": CACHE_DIR,
}


@app.get("/health")
def health() -> dict[str, Any]:
    return health_payload(app)


@app.get("/models")
def models() -> dict[str, Any]:
    return service_state(app)


@app.post("/load_model")
async def load_model_endpoint(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    model = str(payload.get("model") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="Choose a Whisper model to load.")
    try:
        request_switch(app, model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return service_state(app)


@app.post("/cancel_model_load")
async def cancel_model_load() -> dict[str, Any]:
    cancel_switch(app)
    return service_state(app)


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)) -> dict[str, str]:
    content_type = (file.content_type or "").lower()
    if content_type and not (
        content_type.startswith("audio/")
        or content_type in {"application/octet-stream", "video/webm"}
    ):
        raise HTTPException(status_code=415, detail="Upload an audio file.")

    audio = await file.read(MAX_AUDIO_BYTES + 1)
    if not audio:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio file exceeds the 25 MB limit.")

    model = app.state.model
    if model is None:
        detail = app.state.load_error or "The Whisper model is still loading."
        raise HTTPException(status_code=503, detail=detail)

    try:
        async with app.state.transcribe_lock:
            text = await asyncio.to_thread(transcribe_bytes, model, audio)
        return {"text": text}
    except Exception as exc:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def main() -> None:
    args = parse_args()
    device = args.device.strip().lower() or "cpu"
    app.state.config = {
        "model": args.model,
        "device": device,
        "compute_type": compute_type_for(device, args.compute_type),
        "cache_dir": os.path.abspath(args.cache_dir) if args.cache_dir else CACHE_DIR,
    }
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
