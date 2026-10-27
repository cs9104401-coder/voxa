"""Command-line interface: ``python -m asr ...``.

Examples:
    python -m asr models
    python -m asr transcribe --model parakeet-tdt-0.6b-v3 --file speech.wav
    python -m asr transcribe --model whisper-large-v3-turbo --mic
    python -m asr download --model qwen3-asr-1.7b
    python -m asr serve --host 127.0.0.1 --port 8756
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .config import ASRConfig, BACKENDS, DEVICES, LOG_LEVELS
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
from .logging import configure as configure_logging
from .manager import ASRManager
from .registry import get_spec
from .streaming import transcribe_microphone

EXIT_CODES = {
    "usage": 2,
    "backend_unavailable": 3,
    "audio_input_error": 4,
    "transcription_failed": 5,
    "out_of_memory": 6,
    "model_download_failed": 7,
    "model_load_failed": 8,
    "device_unavailable": 9,
    "unsupported_language": 10,
    "cancelled": 130,
}


def _common_parser() -> argparse.ArgumentParser:
    # SUPPRESS is essential: the same option exists on the root parser and on
    # each subcommand, and a subcommand default must not erase a value supplied
    # before the subcommand name.
    parser = argparse.ArgumentParser(add_help=False, argument_default=argparse.SUPPRESS)
    parser.add_argument("--model", help="Model id (default: ASR_MODEL or whisper-large-v3-turbo).")
    parser.add_argument("--backend", choices=BACKENDS, help="Override ASR_BACKEND for this run.")
    parser.add_argument("--device", choices=DEVICES, help="Override ASR_DEVICE.")
    parser.add_argument("--compute-type", help="Override ASR_COMPUTE_TYPE.")
    parser.add_argument("--cache", help="Override ASR_MODEL_CACHE.")
    parser.add_argument("--language", help="Language hint, or omit for automatic detection.")
    parser.add_argument("--chunk-seconds", type=float, help="Chunk length for non-long-form backends.")
    parser.add_argument("--word-timestamps", action="store_true", help="Request timestamps where supported.")
    parser.add_argument("--no-vad", action="store_true", help="Disable VAD where supported.")
    parser.add_argument("--offline", action="store_true", help="Never download; use the cache only.")
    parser.add_argument("--log-level", choices=LOG_LEVELS, help="Log level.")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of text.")
    return parser


def build_parser() -> argparse.ArgumentParser:
    common = _common_parser()
    parser = argparse.ArgumentParser(
        prog="python -m asr",
        parents=[common],
        description="Voxa's local, offline-capable ASR runtime.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("models", parents=[common], help="List supported models and dependency/cache status.")
    sub.add_parser("status", parents=[common], help="Show cache, device, and active-model status.")

    sub.add_parser("download", parents=[common], help="Download a model into the central cache.")

    transcribe = sub.add_parser(
        "transcribe", parents=[common], help="Transcribe a file or one microphone utterance."
    )
    source = transcribe.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", help="Audio file to transcribe.")
    source.add_argument("--mic", action="store_true", help="Capture one utterance from the microphone.")
    transcribe.add_argument("--output", help="Write the transcript text to this file.")
    transcribe.add_argument("--timeout", type=float, help="Maximum seconds to wait for model load (file mode).")
    transcribe.add_argument("--mic-device", help="sounddevice input device name or index for --mic.")

    serve = sub.add_parser("serve", parents=[common], help="Run the localhost HTTP service used by the app.")
    serve.add_argument("--host", default="127.0.0.1", help="Bind address (localhost only by default).")
    serve.add_argument("--port", type=int, default=8756, help="TCP port (default 8756).")
    return parser


def _config_from_args(args: argparse.Namespace) -> ASRConfig:
    overrides: dict[str, Any] = {}
    for argument, field in (
        ("model", "model"),
        ("backend", "backend"),
        ("device", "device"),
        ("compute_type", "compute_type"),
        ("cache", "cache_dir"),
        ("language", "language"),
        ("chunk_seconds", "chunk_seconds"),
        ("log_level", "log_level"),
    ):
        value = getattr(args, argument, None)
        if value is not None:
            overrides[field] = value
    if getattr(args, "word_timestamps", None):
        overrides["word_timestamps"] = True
    if getattr(args, "no_vad", None):
        overrides["vad"] = False
    if getattr(args, "offline", None):
        overrides["offline"] = True
    return ASRConfig.from_env(overrides)


def _print_models(rows: list[dict[str, Any]], as_json: bool) -> None:
    if as_json:
        print(json.dumps(rows, indent=2))
        return
    for row in rows:
        if row["available"] and row["downloaded"]:
            state = "ready"
        elif row["downloaded"]:
            state = "downloaded"
        elif row["available"]:
            state = "installable"
        else:
            state = "unavailable"
        marker = "*" if row.get("active") else ("+" if row.get("selected") else " ")
        print(f"{marker} {row['id']:<40} {state:<12} {row['label']}")
        if not row["available"]:
            print(f"    {row['availability_reason']}")
        capabilities = row.get("capabilities") or {}
        print(
            "    languages: "
            + (", ".join(row["languages"]) if row["languages"] else "multilingual")
            + f"; words: {'yes' if capabilities.get('word_timestamps') else 'no'}"
            + f"; tokens: {'yes' if capabilities.get('token_timestamps') else 'no'}"
            + f"; streaming: {'yes' if capabilities.get('native_streaming') else 'no'}"
            + f"; long-form: {'yes' if capabilities.get('long_form') else 'chunked'}"
        )
    print("\n* active, + selected. Cache and device details: python -m asr status")


def _print_result(result: Any, as_json: bool) -> None:
    payload = result.to_dict()
    if as_json:
        print(json.dumps(payload, indent=2))
        return
    print(payload["text"])
    details = [
        f"model={payload['model_id']}",
        f"backend={payload['backend']}",
        f"device={payload['device']}",
        f"compute={payload['compute_type']}",
    ]
    if payload.get("language"):
        details.append(f"language={payload['language']}")
    timings = payload.get("timings") or {}
    if timings.get("inference_seconds") is not None:
        details.append(f"inference={timings['inference_seconds']}s")
    if timings.get("real_time_factor") is not None:
        details.append(f"rtf={timings['real_time_factor']}")
    words = payload.get("words") or []
    tokens = payload.get("tokens") or []
    if words:
        details.append(f"words={len(words)}")
    if tokens:
        details.append(f"tokens={len(tokens)}")
    print("\n" + " · ".join(details), file=sys.stderr)
    for warning in payload.get("warnings") or []:
        print(f"warning: {warning}", file=sys.stderr)


def _exit_code(error: BaseException) -> int:
    return EXIT_CODES.get(getattr(error, "code", ""), 1)


def _download(manager: ASRManager, model: str) -> int:
    spec = get_spec(model)
    print(f"Downloading {spec.label} from {spec.repo_id or 'the configured path'} ...", file=sys.stderr)
    manager.request_download(spec.id)
    last_line = ""
    while True:
        status = manager.status()
        progress = status.get("progress") or {}
        if progress.get("status") == "downloading":
            percent = progress.get("percent")
            line = (
                f"{progress.get('current_file') or spec.id}: "
                f"{percent if percent is not None else '?'}% "
                f"({progress.get('downloaded_bytes', 0)} / {progress.get('total_bytes', 0)} bytes)"
            )
            if line != last_line:
                print(line, file=sys.stderr)
                last_line = line
        if not status.get("download_active"):
            error = status.get("download_error") or progress.get("error") or ""
            if error:
                raise ModelDownloadError(error)
            if progress.get("status") == "canceled":
                raise CancellationError("The model download was canceled.")
            break
        time.sleep(0.5)
    path = manager.prefetch(spec.id)
    print(str(path))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = bool(getattr(args, "json", False))
    try:
        config = _config_from_args(args)
    except ASRError as exc:
        print(f"configuration error: {exc.message}", file=sys.stderr)
        return EXIT_CODES["usage"]
    configure_logging(config.log_level)

    if args.command == "serve":
        from .service import run_service

        try:
            return run_service(config, host=args.host, port=int(args.port))
        except KeyboardInterrupt:
            return EXIT_CODES["cancelled"]
        except ASRError as exc:
            print(f"{exc.code}: {exc.message}", file=sys.stderr)
            return _exit_code(exc)

    manager = ASRManager(
        config,
        compatibility_cache_dirs=(
            os.getenv("VOXA_WHISPER_CACHE", ""),
            os.getenv("VOXA_ASR_COMPAT_CACHE", ""),
        ),
    )
    cancel_event = threading.Event()
    try:
        if args.command == "models":
            _print_models(manager.list_models(), as_json)
            return 0

        if args.command == "status":
            payload = manager.describe()
            if as_json:
                print(json.dumps(payload, indent=2, default=str))
            else:
                status = payload["status"]
                print(f"cache: {payload['cache_dir']}")
                print(f"device: {payload['device'].get('device')}  cuda: {payload['device'].get('cuda_available')}")
                if payload["device"].get("reason"):
                    print(f"cuda note: {payload['device']['reason']}")
                print(f"model: {status['target_model']}  status: {status['status']}  available: {status['available']}")
                print(f"downloaded: {status['downloaded']}  chunking: {'yes' if status['chunked'] else 'no'}")
                if status.get("error"):
                    print(f"error: {status['error']}")
                if status.get("warnings"):
                    for warning in status["warnings"]:
                        print(f"warning: {warning}")
            return 0

        if args.command == "download":
            return _download(manager, getattr(args, "model", None) or config.model)

        if args.command == "transcribe":
            model_id = getattr(args, "model", None)
            language = getattr(args, "language", None)
            word_timestamps = getattr(args, "word_timestamps", None)
            no_vad = getattr(args, "no_vad", None)
            if args.mic:
                result, captured = transcribe_microphone(
                    manager,
                    config,
                    model_id=model_id,
                    device=args.mic_device or config.mic_device,
                    language=language,
                    word_timestamps=word_timestamps,
                    cancel_event=cancel_event,
                )
                print(f"Captured {captured.duration_seconds:.2f}s of speech.", file=sys.stderr)
            else:
                path = Path(args.file).expanduser()
                if not path.is_file():
                    raise AudioInputError(f"Audio file not found: {path}")
                result = manager.transcribe_file(
                    path,
                    model_id=model_id,
                    language=language,
                    word_timestamps=word_timestamps,
                    vad=False if no_vad else None,
                    cancel_event=cancel_event,
                    timeout=args.timeout,
                )
            if args.output:
                Path(args.output).expanduser().write_text(result.text + "\n", encoding="utf-8")
            _print_result(result, as_json)
            return 0
        parser.error("Unknown command.")
        return EXIT_CODES["usage"]
    except KeyboardInterrupt:
        cancel_event.set()
        print("Cancelled.", file=sys.stderr)
        return EXIT_CODES["cancelled"]
    except CancellationError as exc:
        print(exc.message, file=sys.stderr)
        return EXIT_CODES["cancelled"]
    except (
        UnsupportedModelError,
        UnsupportedLanguageError,
        BackendUnavailableError,
        DeviceUnavailableError,
        ModelDownloadError,
        ModelLoadError,
        OutOfMemoryError,
        AudioInputError,
        ASRError,
    ) as exc:
        print(f"{getattr(exc, 'code', 'asr_error')}: {exc.message}", file=sys.stderr)
        details = getattr(exc, "details", None) or {}
        if details:
            print(json.dumps(details, indent=2), file=sys.stderr)
        return _exit_code(exc)
    finally:
        manager.shutdown()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
