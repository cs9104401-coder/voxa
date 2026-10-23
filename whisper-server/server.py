from __future__ import annotations

import argparse
import asyncio
import logging
import os


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
from io import BytesIO
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel
from faster_whisper.utils import _MODELS, disabled_tqdm
from huggingface_hub import HfApi, snapshot_download
from huggingface_hub.constants import HF_HUB_CACHE

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MODEL_FILE_PATTERNS = [
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
]
logger = logging.getLogger("voxa.whisper")


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
    return filename in {
        "config.json",
        "preprocessor_config.json",
        "model.bin",
        "tokenizer.json",
    } or filename.startswith("vocabulary.")


def repo_id_for(model: str) -> str | None:
    if "/" in model:
        return model
    return _MODELS.get(model)


def model_cache_bytes(repo_id: str) -> int:
    blobs = Path(HF_HUB_CACHE) / f"models--{repo_id.replace('/', '--')}" / "blobs"
    try:
        return sum(item.stat().st_size for item in blobs.iterdir() if item.is_file())
    except OSError:
        return 0


def model_snapshot_ready(local_path: str) -> bool:
    path = Path(local_path)
    try:
        required = ("config.json", "model.bin", "tokenizer.json")
        if not all((path / name).is_file() and (path / name).stat().st_size > 0 for name in required):
            return False
        return any(item.is_file() and item.stat().st_size > 0 and item.name.startswith("vocabulary.") for item in path.iterdir())
    except OSError:
        return False


def expected_download_bytes(repo_id: str) -> int:
    info = HfApi().model_info(repo_id, files_metadata=True)
    return sum(
        sibling.size or 0
        for sibling in info.siblings
        if allowed_model_file(sibling.rfilename)
    )


def update_download_progress(application: FastAPI, repo_id: str) -> None:
    download = application.state.download
    downloaded = model_cache_bytes(repo_id)
    total = int(download.get("total_bytes") or 0)
    percent = min(100, int(downloaded * 100 / total)) if total > 0 else None
    application.state.download = {
        **download,
        "status": "downloading",
        "downloaded_bytes": downloaded,
        "total_bytes": total,
        "percent": percent,
    }


async def prepare_model(application: FastAPI) -> str:
    config = application.state.config
    requested = config["model"]
    if os.path.isdir(requested):
        return requested

    repo_id = repo_id_for(requested)
    if not repo_id:
        raise ValueError(
            f"Unknown Whisper model '{requested}'. Choose a supported model such as small or large-v3."
        )

    force_download = False
    try:
        local = await asyncio.to_thread(
            snapshot_download,
            repo_id,
            local_files_only=True,
            allow_patterns=MODEL_FILE_PATTERNS,
            tqdm_class=disabled_tqdm,
        )
        if model_snapshot_ready(local):
            downloaded = model_cache_bytes(repo_id)
            application.state.download = {
                "status": "complete",
                "downloaded_bytes": downloaded,
                "total_bytes": downloaded,
                "percent": 100,
            }
            logger.info("Using cached Whisper model at %s", local)
            return local
        force_download = True
    except Exception:
        pass

    application.state.download = {
        "status": "preparing",
        "downloaded_bytes": model_cache_bytes(repo_id),
        "total_bytes": 0,
        "percent": None,
    }
    try:
        total = await asyncio.to_thread(expected_download_bytes, repo_id)
    except Exception as exc:
        total = 0
        logger.warning("Could not determine the download size for %s: %s", repo_id, exc)
    application.state.download = {
        **application.state.download,
        "status": "downloading",
        "total_bytes": total,
    }

    logger.info("Downloading %s (%s bytes) before loading it", repo_id, total or "unknown")
    download_task = asyncio.create_task(
        asyncio.to_thread(
            snapshot_download,
            repo_id,
            allow_patterns=MODEL_FILE_PATTERNS,
            tqdm_class=disabled_tqdm,
            force_download=force_download,
        )
    )
    while not download_task.done():
        update_download_progress(application, repo_id)
        await asyncio.sleep(0.5)

    local = await download_task
    if not model_snapshot_ready(local):
        raise RuntimeError(f"The downloaded Whisper model at {local} is incomplete.")
    downloaded = model_cache_bytes(repo_id)
    application.state.download = {
        "status": "complete",
        "downloaded_bytes": downloaded,
        "total_bytes": max(downloaded, total),
        "percent": 100,
    }
    logger.info("Whisper model download complete: %s", local)
    return local


async def load_model(application: FastAPI) -> None:
    config = application.state.config
    try:
        local_model = await prepare_model(application)
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
        application.state.model = model
        application.state.load_error = ""
        logger.info("Whisper model is ready: %s", config["model"])
    except Exception as exc:  # Model download and CUDA failures are reported through /health.
        application.state.load_error = str(exc) or exc.__class__.__name__
        logger.exception("Whisper model failed to load")


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.model = None
    application.state.load_error = ""
    application.state.download = {
        "status": "preparing",
        "downloaded_bytes": 0,
        "total_bytes": 0,
        "percent": None,
    }
    application.state.transcribe_lock = asyncio.Lock()
    application.state.model_task = asyncio.create_task(load_model(application))
    try:
        yield
    finally:
        task = application.state.model_task
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
    config = app.state.config
    ready = app.state.model is not None
    task = app.state.model_task
    download = getattr(app.state, "download", {}) or {}
    if ready:
        status = "ready"
    elif app.state.load_error:
        status = "error"
    elif task and task.done():
        status = "error"
    elif download.get("status") in {"preparing", "downloading"}:
        status = "downloading"
    else:
        status = "loading"

    percent = download.get("percent")
    if status == "downloading":
        message = (
            f"Downloading the {config['model']} model ({percent}%)."
            if percent is not None
            else f"Preparing the {config['model']} model download."
        )
    elif status == "loading":
        message = f"Loading the {config['model']} model on {config['device']}."
    elif status == "ready":
        message = f"The {config['model']} model is ready."
    else:
        message = app.state.load_error or "The Whisper model failed to load."

    payload: dict[str, Any] = {
        "ok": ready,
        "status": status,
        "model": config["model"],
        "device": config["device"],
        "compute_type": config["compute_type"],
        "cache_dir": config.get("cache_dir", ""),
        "message": message,
        "progress": {
            "status": download.get("status", "idle"),
            "downloaded_bytes": int(download.get("downloaded_bytes") or 0),
            "total_bytes": int(download.get("total_bytes") or 0),
            "percent": percent,
        },
    }
    if app.state.load_error:
        payload["error"] = app.state.load_error
    return payload


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
