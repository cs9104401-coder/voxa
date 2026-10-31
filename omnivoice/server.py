#!/usr/bin/env python3
"""OmniVoice local TTS sidecar.

The Electron app starts this process with its own virtual environment and the
model directory produced by ``scripts/setup-omnivoice.cjs``.  The server binds
to loopback only, loads the model once in a background thread, and serialises
GPU inference so a sentence queue cannot overlap on the device.

Endpoints
---------
GET  /health  -> load state, device, sample rate, and GPU information
POST /tts     -> {"text", "ref_audio", "ref_text", "instruct", "language",
                  "speed"} and a 16-bit WAV response
"""

from __future__ import annotations

import argparse
import asyncio
import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
import uvicorn

MAX_TEXT_CHARS = 1200
MAX_REF_TEXT_CHARS = 2000
MAX_INSTRUCT_CHARS = 300
MAX_REF_AUDIO_BYTES = 50 * 1024 * 1024
MAX_PROMPT_CACHE = 4
AUDIO_SUFFIXES = {
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".m4a",
    ".aac",
    ".webm",
}

LOGGER = logging.getLogger("omnivoice.server")


@dataclass
class RuntimeState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    status: str = "loading"
    load_error: str = ""
    load_started_at: float = field(default_factory=time.time)
    loaded_at: float = 0.0
    load_seconds: float = 0.0
    device: str = "cpu"
    dtype: str = "float32"
    sample_rate: int = 24_000
    model_path: str = ""
    cuda_available: bool = False
    cuda_device_name: str = ""
    vram_total_mb: int = 0
    vram_free_mb: int = 0
    requests: int = 0
    last_error: str = ""


STATE = RuntimeState()
MODEL: Any = None
INFERENCE_LOCK = threading.Lock()
PROMPT_LOCK = threading.Lock()
PROMPT_CACHE: dict[tuple[str, int, int, str], Any] = {}
PROMPT_ORDER: list[tuple[str, int, int, str]] = []

CONFIG: dict[str, Any] = {
    "model_path": "k2-fsa/OmniVoice",
    "device": "auto",
}


class TTSRequest(BaseModel):
    text: str = Field(default="", max_length=MAX_TEXT_CHARS)
    ref_audio: Optional[str] = None
    ref_text: Optional[str] = None
    instruct: Optional[str] = None
    language: Optional[str] = None
    speed: Optional[float] = None


def _set_state(**changes: Any) -> None:
    with STATE.lock:
        for key, value in changes.items():
            setattr(STATE, key, value)


def _state_snapshot() -> dict[str, Any]:
    with STATE.lock:
        return {
            "status": STATE.status,
            "load_error": STATE.load_error,
            "load_started_at": STATE.load_started_at,
            "loaded_at": STATE.loaded_at,
            "load_seconds": STATE.load_seconds,
            "device": STATE.device,
            "dtype": STATE.dtype,
            "sample_rate": STATE.sample_rate,
            "model_path": STATE.model_path,
            "cuda_available": STATE.cuda_available,
            "cuda_device_name": STATE.cuda_device_name,
            "vram_total_mb": STATE.vram_total_mb,
            "vram_free_mb": STATE.vram_free_mb,
            "requests": STATE.requests,
            "last_error": STATE.last_error,
        }


def _choose_device(requested: str) -> tuple[str, torch.dtype]:
    requested = (requested or "auto").strip().lower()
    if requested in {"cuda", "cuda:0"}:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested, but torch.cuda.is_available() is false.")
        return "cuda:0", torch.float16
    if requested in {"cpu", "mps", "xpu"}:
        if requested == "mps":
            return "mps", torch.float16
        if requested == "xpu":
            if not hasattr(torch, "xpu") or not torch.xpu.is_available():
                raise RuntimeError("XPU was requested, but torch.xpu.is_available() is false.")
            return "xpu", torch.bfloat16
        return "cpu", torch.float32
    if torch.cuda.is_available() and torch.cuda.device_count() > 0:
        return "cuda:0", torch.float16
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu", torch.bfloat16
    return "cpu", torch.float32


def _gpu_details(device: str) -> dict[str, Any]:
    details: dict[str, Any] = {
        "cuda_available": bool(torch.cuda.is_available()),
        "cuda_device_name": "",
        "vram_total_mb": 0,
        "vram_free_mb": 0,
    }
    if torch.cuda.is_available():
        try:
            details["cuda_device_name"] = torch.cuda.get_device_name(0)
        except Exception:
            details["cuda_device_name"] = ""
        try:
            free_bytes, total_bytes = torch.cuda.mem_get_info(0)
            details["vram_total_mb"] = int(total_bytes // (1024 * 1024))
            details["vram_free_mb"] = int(free_bytes // (1024 * 1024))
        except Exception:
            pass
    return details


def _load_model_worker() -> None:
    started = time.time()
    try:
        from omnivoice import OmniVoice

        device, dtype = _choose_device(str(CONFIG.get("device") or "auto"))
        model_path = str(CONFIG.get("model_path") or "k2-fsa/OmniVoice")
        details = _gpu_details(device)
        _set_state(
            status="loading",
            device=device,
            dtype=str(dtype).replace("torch.", ""),
            model_path=model_path,
            load_error="",
            **details,
        )
        LOGGER.info("Loading OmniVoice from %s on %s (%s)…", model_path, device, dtype)
        model = OmniVoice.from_pretrained(model_path, device_map=device, dtype=dtype)
        model.eval()
        sample_rate = int(getattr(model, "sampling_rate", 0) or 24_000)
        global MODEL
        MODEL = model
        # The first diffusion pass pays a large one-time CUDA/kernel cost (about
        # 11–20 s on a desktop GPU). Run a one-step warmup before reporting ready
        # so the user's first spoken sentence does not wait for that setup.
        warm_started = time.time()
        try:
            with INFERENCE_LOCK:
                model.generate(text="Hi.", num_step=1)
            LOGGER.info("Warmup finished in %.1f seconds.", time.time() - warm_started)
        except Exception as warm_error:  # noqa: BLE001 - warmup must not hide a usable model
            LOGGER.warning("Warmup failed after %.1f seconds: %s", time.time() - warm_started, warm_error)
        elapsed = time.time() - started
        _set_state(
            status="ready",
            loaded_at=time.time(),
            load_seconds=elapsed,
            sample_rate=sample_rate,
            load_error="",
            **details,
        )
        LOGGER.info("OmniVoice ready at %d Hz in %.1f seconds.", sample_rate, elapsed)
    except Exception as error:  # noqa: BLE001 - health must report any load failure
        elapsed = time.time() - started
        message = f"{type(error).__name__}: {error}"
        _set_state(status="error", load_error=message, load_seconds=elapsed)
        LOGGER.exception("OmniVoice failed to load after %.1f seconds.", elapsed)


def _clean_text(value: Optional[str], limit: int) -> str:
    if not value:
        return ""
    return " ".join(str(value).replace("\x00", " ").split())[:limit]


def _resolve_ref_audio(value: Optional[str]) -> Optional[Path]:
    if not value:
        return None
    path = Path(str(value)).expanduser()
    try:
        path = path.resolve(strict=True)
    except OSError as error:
        raise HTTPException(status_code=400, detail=f"Reference audio not found: {error}") from error
    if not path.is_file():
        raise HTTPException(status_code=400, detail="Reference audio is not a file.")
    if path.suffix.lower() not in AUDIO_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"Unsupported reference audio type: {path.suffix or 'none'}")
    try:
        if path.stat().st_size > MAX_REF_AUDIO_BYTES:
            raise HTTPException(status_code=400, detail="Reference audio is larger than 50 MB.")
    except OSError as error:
        raise HTTPException(status_code=400, detail=f"Could not read reference audio: {error}") from error
    return path


def _voice_prompt(ref_audio: Optional[Path], ref_text: str) -> Any:
    if ref_audio is None:
        return None
    stat = ref_audio.stat()
    key = (str(ref_audio), stat.st_mtime_ns, stat.st_size, ref_text)
    with PROMPT_LOCK:
        cached = PROMPT_CACHE.get(key)
        if cached is not None:
            return cached
    prompt = MODEL.create_voice_clone_prompt(
        ref_audio=str(ref_audio),
        ref_text=ref_text or None,
    )
    with PROMPT_LOCK:
        PROMPT_CACHE[key] = prompt
        PROMPT_ORDER.append(key)
        while len(PROMPT_ORDER) > MAX_PROMPT_CACHE:
            old = PROMPT_ORDER.pop(0)
            PROMPT_CACHE.pop(old, None)
    return prompt


def _synthesize(request: TTSRequest) -> tuple[bytes, int]:
    text = _clean_text(request.text, MAX_TEXT_CHARS)
    if not text:
        raise HTTPException(status_code=400, detail="No text was provided.")
    ref_text = _clean_text(request.ref_text, MAX_REF_TEXT_CHARS)
    instruct = _clean_text(request.instruct, MAX_INSTRUCT_CHARS)
    language = _clean_text(request.language, 80) or None
    speed = request.speed
    if speed is not None:
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            speed = None
        if speed is not None:
            speed = max(0.5, min(2.0, speed))
    ref_audio = _resolve_ref_audio(request.ref_audio)

    with INFERENCE_LOCK:
        if MODEL is None:
            raise HTTPException(status_code=503, detail="The OmniVoice model is not ready.")
        try:
            prompt = _voice_prompt(ref_audio, ref_text)
            kwargs: dict[str, Any] = {"text": text}
            if prompt is not None:
                kwargs["voice_clone_prompt"] = prompt
            elif instruct:
                kwargs["instruct"] = instruct
            if language:
                kwargs["language"] = language
            if speed is not None:
                kwargs["speed"] = speed
            audios = MODEL.generate(**kwargs)
        except HTTPException:
            raise
        except Exception as error:  # noqa: BLE001 - expose a useful synthesis error
            message = f"{type(error).__name__}: {error}"
            _set_state(last_error=message)
            LOGGER.exception("OmniVoice synthesis failed.")
            raise HTTPException(status_code=500, detail=message) from error

    if not audios:
        raise HTTPException(status_code=500, detail="OmniVoice returned no audio.")
    pieces: list[np.ndarray] = []
    for piece in audios:
        array = np.asarray(piece, dtype=np.float32).reshape(-1)
        if array.size:
            pieces.append(array)
    if not pieces:
        raise HTTPException(status_code=500, detail="OmniVoice returned empty audio.")
    audio = pieces[0] if len(pieces) == 1 else np.concatenate(pieces)
    audio = np.nan_to_num(audio, nan=0.0, posinf=1.0, neginf=-1.0)
    np.clip(audio, -1.0, 1.0, out=audio)
    sample_rate = int(getattr(MODEL, "sampling_rate", 0) or _state_snapshot()["sample_rate"])
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue(), sample_rate


@asynccontextmanager
async def lifespan(_app: FastAPI):
    thread = threading.Thread(target=_load_model_worker, name="omnivoice-loader", daemon=True)
    thread.start()
    yield


app = FastAPI(title="OmniVoice local TTS", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    state = _state_snapshot()
    return {
        "ok": state["status"] == "ready",
        "service": "omnivoice",
        "pid": os.getpid(),
        **state,
        "torch_version": torch.__version__,
        "torch_cuda_version": torch.version.cuda if torch.cuda.is_available() else None,
    }


@app.get("/")
async def root() -> dict[str, Any]:
    return {"service": "omnivoice", "health": "/health", "tts": "/tts"}


@app.post("/tts")
async def tts(request: TTSRequest) -> Response:
    state = _state_snapshot()
    if state["status"] == "loading":
        raise HTTPException(status_code=503, detail="The OmniVoice model is still loading.", headers={"Retry-After": "5"})
    if state["status"] != "ready":
        raise HTTPException(status_code=503, detail=state["load_error"] or "The OmniVoice model is not ready.")
    try:
        wav, sample_rate = await asyncio.to_thread(_synthesize, request)
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001
        LOGGER.exception("Unexpected /tts failure.")
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}") from error
    _set_state(requests=state["requests"] + 1)
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Sample-Rate": str(sample_rate),
        },
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OmniVoice local TTS sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model-path", default="k2-fsa/OmniVoice")
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda:0, mps, or xpu")
    parser.add_argument("--log-level", default="info")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="[omnivoice] %(levelname)s %(message)s",
    )
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    CONFIG["model_path"] = args.model_path
    CONFIG["device"] = args.device
    _set_state(model_path=args.model_path, device=args.device, sample_rate=24_000)
    LOGGER.info("Listening on http://%s:%d", args.host, args.port)
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=str(args.log_level).lower(),
        access_log=False,
    )


if __name__ == "__main__":
    main()
