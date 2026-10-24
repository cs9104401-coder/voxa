"""
Voxa Kokoro TTS server — runs on 127.0.0.1:8001 (default).
Exposes POST /v1/audio/speech (OpenAI-compatible subset) and GET /health.

The model ONNX file and voice .bin files must already be present in the
paths passed via --model-path and --voices-dir; this server never downloads
anything.  The Node.js layer (lib/tts-kokoro.cjs) handles consent and
download before spawning this process.

Circuit breaker: after TTS_CIRCUIT_FAILURES consecutive synthesis errors the
server sets its health to "error" and returns 503 for synthesis requests until
it is restarted.  Health checks always return 200.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

# Configure logging before any imports that might log at import time.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("voxa.kokoro")

import soundfile as sf  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

# kokoro_onnx is imported lazily inside _load_model() so startup is instant
# and import errors surface as a clean 503 rather than a crash.

# ── Constants ─────────────────────────────────────────────────────────────────
MAX_TEXT_CHARS = 2000
TTS_CIRCUIT_FAILURES = 3      # consecutive failures before circuit opens
DEFAULT_SAMPLE_RATE = 24000   # Kokoro-82M native output rate


# ── Global state ─────────────────────────────────────────────────────────────
class _State:
    model: Any = None                  # KokoroOnnx instance or None
    model_path: str = ""
    voices_dir: str = ""
    load_error: str = ""
    loading: bool = False
    consecutive_failures: int = 0
    circuit_open: bool = False
    synth_lock: asyncio.Lock | None = None


_state = _State()


# ── Model loading ─────────────────────────────────────────────────────────────

def _load_model_sync(model_path: str, voices_dir: str) -> Any:
    """Load KokoroOnnx from disk.  Runs in a thread pool."""
    from kokoro_onnx import KokoroOnnx  # type: ignore[import-untyped]
    logger.info("Loading Kokoro model from %s", model_path)
    model = KokoroOnnx(model_path, voices_dir=voices_dir)
    logger.info("Kokoro model ready")
    return model


async def _ensure_model() -> Any:
    """Return the loaded model, loading it lazily on first call."""
    if _state.model is not None:
        return _state.model
    if _state.load_error:
        raise RuntimeError(_state.load_error)
    if _state.loading:
        # Another coroutine is already loading; wait briefly.
        for _ in range(120):
            await asyncio.sleep(0.5)
            if _state.model is not None:
                return _state.model
            if _state.load_error:
                raise RuntimeError(_state.load_error)
        raise RuntimeError("Kokoro model loading timed out.")
    _state.loading = True
    try:
        model = await asyncio.to_thread(_load_model_sync, _state.model_path, _state.voices_dir)
        _state.model = model
        _state.load_error = ""
        return model
    except Exception as exc:
        _state.load_error = str(exc) or exc.__class__.__name__
        logger.exception("Kokoro model load failed")
        raise RuntimeError(_state.load_error) from exc
    finally:
        _state.loading = False


# ── Synthesis ─────────────────────────────────────────────────────────────────

def _synthesize_sync(model: Any, text: str, voice: str, speed: float) -> bytes:
    """Run Kokoro synthesis and encode result as WAV.  Runs in a thread pool."""
    samples, sample_rate = model.create(text, voice=voice, speed=speed)
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ── FastAPI app ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(application: FastAPI):
    _state.synth_lock = asyncio.Lock()
    # Begin loading the model in the background immediately so the first
    # synthesis request does not have to wait for the full load.
    asyncio.create_task(_ensure_model())
    try:
        yield
    finally:
        _state.model = None


app = FastAPI(title="Voxa Kokoro TTS", lifespan=lifespan)


class SpeechRequest(BaseModel):
    input: str
    voice: str = "af_heart"
    speed: float = 1.0
    # response_format is accepted but ignored — we always return WAV.
    response_format: str = "wav"


@app.get("/health")
def health() -> dict[str, Any]:
    loading = _state.loading or (_state.model is None and not _state.load_error and not _state.circuit_open)
    if _state.circuit_open:
        status = "error"
    elif _state.model is not None:
        status = "ready"
    elif _state.load_error:
        status = "error"
    elif loading:
        status = "loading"
    else:
        status = "idle"
    return {
        "ok": _state.model is not None and not _state.circuit_open,
        "status": status,
        "load_error": _state.load_error,
        "circuit_open": _state.circuit_open,
        "consecutive_failures": _state.consecutive_failures,
        "model_path": _state.model_path,
        "voices_dir": _state.voices_dir,
    }


@app.post("/v1/audio/speech")
async def synthesize(req: SpeechRequest) -> Response:
    # Circuit breaker: too many consecutive failures — refuse requests.
    if _state.circuit_open:
        raise HTTPException(
            status_code=503,
            detail="Kokoro TTS circuit breaker is open after repeated failures. Restart the server."
        )

    # Input validation.
    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input must not be empty.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"input exceeds the {MAX_TEXT_CHARS}-character limit."
        )
    speed = float(req.speed)
    if speed < 0.5 or speed > 2.0:
        raise HTTPException(status_code=400, detail="speed must be between 0.5 and 2.0.")
    voice = str(req.voice).strip() or "af_heart"
    if len(voice) > 60:
        raise HTTPException(status_code=400, detail="voice name too long.")

    # Ensure model is loaded.
    try:
        model = await _ensure_model()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # Serialize synthesis (Kokoro ONNX is not thread-safe for concurrent calls).
    assert _state.synth_lock is not None
    async with _state.synth_lock:
        try:
            wav_bytes = await asyncio.to_thread(_synthesize_sync, model, text, voice, speed)
            # Reset circuit breaker on success.
            _state.consecutive_failures = 0
            return Response(content=wav_bytes, media_type="audio/wav")
        except Exception as exc:
            _state.consecutive_failures += 1
            logger.error(
                "Synthesis failed (%d consecutive): %s",
                _state.consecutive_failures,
                exc,
            )
            if _state.consecutive_failures >= TTS_CIRCUIT_FAILURES:
                _state.circuit_open = True
                logger.error("Kokoro circuit breaker opened after %d failures.", TTS_CIRCUIT_FAILURES)
            raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Entry point ───────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Voxa Kokoro TTS server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.getenv("KOKORO_PORT", "8001")))
    parser.add_argument(
        "--model-path",
        default=os.getenv("KOKORO_MODEL_PATH", ""),
        help="Absolute path to model_q8f16.onnx (or model_uint8.onnx).",
    )
    parser.add_argument(
        "--voices-dir",
        default=os.getenv("KOKORO_VOICES_DIR", ""),
        help="Directory containing the voice .bin files.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if not args.model_path:
        raise SystemExit("--model-path is required.")
    if not args.voices_dir:
        raise SystemExit("--voices-dir is required.")
    if not os.path.isfile(args.model_path):
        raise SystemExit(f"Model file not found: {args.model_path}")
    if not os.path.isdir(args.voices_dir):
        raise SystemExit(f"Voices directory not found: {args.voices_dir}")

    _state.model_path = os.path.abspath(args.model_path)
    _state.voices_dir = os.path.abspath(args.voices_dir)

    logger.info(
        "Kokoro TTS server starting on %s:%d  model=%s  voices=%s",
        args.host, args.port, _state.model_path, _state.voices_dir,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
