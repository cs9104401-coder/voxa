"""Central model cache, official Hugging Face downloads, and artifact validation."""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .errors import CancellationError, ModelDownloadError
from .registry import ModelSpec

LOGGER = logging.getLogger("voxa.asr.downloads")
CHUNK_BYTES = 1024 * 1024
STALL_SECONDS = 60
USER_AGENT = "Voxa-ASR/2.0"
ALLOWED_SUFFIXES = (
    ".json",
    ".safetensors",
    ".bin",
    ".txt",
    ".model",
    ".tiktoken",
    ".vocab",
    ".merges",
    ".spm",
)
DENIED_PREFIXES = (
    "assets/",
    "images/",
    "docs/",
    "examples/",
    "onnx/",
    "gguf/",
    "plots/",
    ".eval_results/",
)
DENIED_NAMES = {"README.md", "LICENSE", ".gitattributes", "training_args.bin", "model.sig"}


@dataclass
class DownloadProgress:
    model: str
    status: str = "idle"
    downloaded_bytes: int = 0
    total_bytes: int = 0
    percent: int | None = None
    speed_bps: float = 0.0
    current_file: str = ""
    stalled: bool = False
    error: str = ""
    started_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "status": self.status,
            "downloaded_bytes": self.downloaded_bytes,
            "total_bytes": self.total_bytes,
            "percent": self.percent,
            "speed_bps": self.speed_bps,
            "current_file": self.current_file,
            "stalled": self.stalled,
            "error": self.error,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _safe_relative(name: str) -> str | None:
    text = str(name).replace("\\", "/").lstrip("/")
    if not text or text.endswith("/"):
        return None
    parts = text.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    if text in DENIED_NAMES or text.startswith(DENIED_PREFIXES):
        return None
    lower = text.lower()
    if not lower.endswith(ALLOWED_SUFFIXES):
        return None
    return text


class ModelStore:
    """One cache shared by the CLI and the service.

    The store only downloads from the official Hugging Face repository named in
    the registry. It never accepts a URL from the renderer.
    """

    def __init__(
        self,
        cache_dir: str,
        *,
        offline: bool = False,
        compatibility_cache_dirs: tuple[str, ...] = (),
        progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.cache_dir = Path(cache_dir).expanduser().resolve()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.offline = bool(offline)
        self.compatibility_cache_dirs = tuple(
            Path(item).expanduser().resolve()
            for item in compatibility_cache_dirs
            if str(item or "").strip()
        )
        self.progress = progress
        self._lock = threading.RLock()
        # Serialize downloads without holding the state lock. The progress
        # callback may call back into status() (the manager polls it), so
        # holding _lock across a download would deadlock two threads.
        self._download_lock = threading.Lock()
        self._state = DownloadProgress(model="")
        self._last_progress_monotonic = time.monotonic()

    # ------------------------------------------------------------------ public
    def model_dir(self, spec: ModelSpec) -> Path:
        return self.cache_dir / "models" / spec.id

    def existing_path(self, spec: ModelSpec) -> Path | None:
        names = self._cache_names(spec)
        for root in (self.cache_dir, *self.compatibility_cache_dirs):
            for name in names:
                candidate = root / "models" / name
                if self._ready(candidate, spec):
                    return candidate
            if root != self.cache_dir and spec.repo_id:
                repo_dir = root / "hub" / f"models--{spec.repo_id.replace('/', '--')}"
                snapshots = repo_dir / "snapshots"
                try:
                    entries = sorted(
                        (item for item in snapshots.iterdir() if item.is_dir()),
                        reverse=True,
                    )
                except OSError:
                    entries = []
                for entry in entries:
                    if self._ready(entry, spec):
                        return entry
        return None

    def status(self) -> dict[str, Any]:
        with self._lock:
            payload = self._state.to_dict()
            if payload.get("status") == "downloading":
                payload["stalled"] = (
                    time.monotonic() - self._last_progress_monotonic >= STALL_SECONDS
                )
            return payload

    def resolve(self, spec: ModelSpec, cancel_event: threading.Event | None = None) -> Path:
        existing = self.existing_path(spec)
        if existing is not None:
            return existing
        if self.offline:
            raise ModelDownloadError(
                f"{spec.label} is not present in the model cache ({self.cache_dir}) and ASR_OFFLINE is enabled. "
                "Download it while online or point ASR_MODEL_CACHE at an existing cache."
            )
        if not spec.repo_id:
            raise ModelDownloadError(f"{spec.label} has no official download repository.")
        with self._download_lock:
            # A second caller may have finished while this one waited.
            existing = self.existing_path(spec)
            if existing is not None:
                return existing
            return self._download(spec, cancel_event)

    # ----------------------------------------------------------------- private
    @staticmethod
    def _cache_names(spec: ModelSpec) -> tuple[str, ...]:
        names = [spec.id, *spec.cache_names]
        return tuple(dict.fromkeys(name for name in names if name))

    def _ready(self, path: Path, spec: ModelSpec) -> bool:
        if not path.is_dir():
            return False
        try:
            for name in spec.required_files:
                if "*" in name:
                    if not any(item.is_file() and item.stat().st_size > 0 for item in path.glob(name)):
                        return False
                    continue
                item = path / name
                if not item.is_file() or item.stat().st_size <= 0:
                    return False

            if spec.requires_index:
                index_file = path / "model.safetensors.index.json"
                if not index_file.is_file() or index_file.stat().st_size <= 0:
                    return False
                try:
                    metadata = json.loads(index_file.read_text(encoding="utf-8"))
                    weight_map = metadata.get("weight_map")
                    if not isinstance(weight_map, dict) or not weight_map:
                        return False
                    shards = {str(name) for name in weight_map.values()}
                    for shard in shards:
                        item = path / shard
                        if not item.is_file() or item.stat().st_size <= 0:
                            return False
                except (OSError, ValueError):
                    return False
                return True

            for prefix in spec.required_weight_prefixes:
                for item in path.glob(prefix):
                    if item.is_file() and item.stat().st_size > 0:
                        return True
            return False
        except OSError:
            return False

    def _set(self, **updates: Any) -> None:
        with self._lock:
            current = self._state.to_dict()
            current.update(updates)
            current["updated_at"] = _now()
            self._state = DownloadProgress(**current)
            if "downloaded_bytes" in updates or "current_file" in updates:
                self._last_progress_monotonic = time.monotonic()
            snapshot = self._state.to_dict()
        if self.progress:
            try:
                self.progress(snapshot)
            except Exception:
                LOGGER.debug("Download progress callback failed", exc_info=True)

    def _list_files(self, repo_id: str) -> list[tuple[str, int]]:
        from huggingface_hub import HfApi

        token = os.getenv("HF_TOKEN", "").strip() or None
        info = HfApi(token=token).model_info(repo_id, files_metadata=True)
        files: list[tuple[str, int]] = []
        for sibling in info.siblings or []:
            name = _safe_relative(str(sibling.rfilename))
            if name:
                files.append((name, int(sibling.size or 0)))
        if not files:
            raise ModelDownloadError(f"No supported model files were found in {repo_id}.")
        return files

    def _download(self, spec: ModelSpec, cancel_event: threading.Event | None) -> Path:
        assert spec.repo_id
        target = self.model_dir(spec)
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ModelDownloadError(f"Could not create the model cache at {target}: {exc}") from exc
        self._set(
            model=spec.id,
            status="preparing",
            downloaded_bytes=_completed(target),
            total_bytes=0,
            percent=None,
            speed_bps=0,
            current_file="",
            stalled=False,
            error="",
            started_at=_now(),
        )
        try:
            files = self._list_files(spec.repo_id)
        except Exception as exc:
            message = f"Could not read the official model manifest for {spec.repo_id}: {exc}"
            self._set(status="error", error=message)
            raise ModelDownloadError(message) from exc
        total = sum(size for _name, size in files) or spec.approx_size_bytes
        free = _free_bytes(target)
        if total and free and total > free:
            message = f"Not enough disk space for {spec.label}: {total} bytes required, {free} available."
            self._set(status="error", error=message)
            raise ModelDownloadError(message)
        self._set(
            status="downloading",
            total_bytes=total,
            downloaded_bytes=_completed(target),
            percent=_percent(_completed(target), total),
        )
        LOGGER.info("Downloading %s from %s into %s", spec.id, spec.repo_id, target)

        last_report = time.monotonic()
        downloaded = _completed(target)
        last_bytes = downloaded
        last_at = time.monotonic()
        last_progress = last_at
        speed = 0.0
        stalled = False

        def report(current: int, *, force: bool = False) -> None:
            nonlocal last_report, last_bytes, last_at, last_progress, speed, stalled
            now = time.monotonic()
            elapsed = max(0.001, now - last_at)
            if current > last_bytes:
                speed = (current - last_bytes) / elapsed
                last_progress = now
                stalled = False
            elif current < last_bytes:
                # A failed attempt discards its partial file, so progress moves
                # backwards before the retry starts. Reset the rate and stall
                # timer instead of showing a stale or negative speed.
                speed = 0.0
                last_progress = now
                stalled = False
            elif now - last_progress >= STALL_SECONDS:
                stalled = True
            last_bytes = current
            last_at = now
            if force or now - last_report >= 0.4:
                last_report = now
                self._set(
                    downloaded_bytes=current,
                    total_bytes=max(total, current),
                    percent=_percent(current, max(total, current)),
                    speed_bps=round(speed, 2),
                    stalled=stalled,
                )

        for name, size in files:
            if cancel_event is not None and cancel_event.is_set():
                self._set(status="canceled", error="The model download was canceled.", speed_bps=0, stalled=False)
                raise CancellationError("The model download was canceled.")
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                if destination.is_file() and (size <= 0 or destination.stat().st_size == size):
                    continue
            except OSError:
                pass
            self._set(current_file=name)
            # Report progress inside the file as well as after it. Without this
            # a single multi-gigabyte shard would sit at 0% until completion.
            file_base = _completed(target)
            last_bytes = file_base
            last_at = time.monotonic()
            last_progress = last_at
            speed = 0.0
            stalled = False

            def on_chunk(written: int, base: int = file_base) -> None:
                report(base + written)

            try:
                self._fetch_file(spec.repo_id, name, destination, size, cancel_event, on_progress=on_chunk)
            except CancellationError:
                self._set(status="canceled", error="The model download was canceled.", speed_bps=0, stalled=False)
                raise
            except ModelDownloadError as exc:
                # The transfer can fail after the store entered "downloading".
                # Publish a terminal snapshot so progress never keeps claiming
                # that bytes are still arriving.
                self._set(status="error", error=exc.message, speed_bps=0, stalled=False)
                raise
            report(_completed(target), force=True)
        if not self._ready(target, spec):
            message = f"The downloaded files for {spec.label} are incomplete in {target}."
            self._set(status="error", error=message)
            raise ModelDownloadError(message)
        final = _completed(target)
        self._set(
            status="complete",
            downloaded_bytes=final,
            total_bytes=max(total, final),
            percent=100,
            speed_bps=0,
            current_file="",
            stalled=False,
            error="",
        )
        LOGGER.info("Model ready: %s (%s bytes)", spec.id, final)
        return target

    def _fetch_file(
        self,
        repo_id: str,
        filename: str,
        destination: Path,
        size: int,
        cancel_event: threading.Event | None,
        on_progress: Callable[[int], None] | None = None,
    ) -> None:
        from huggingface_hub import hf_hub_url

        url = hf_hub_url(repo_id, filename)
        part = destination.with_name(f"{destination.name}.{os.getpid()}-{time.time_ns()}.part")
        headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
        token = os.getenv("HF_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(url, headers=headers)
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                if cancel_event is not None and cancel_event.is_set():
                    raise CancellationError("The model download was canceled.")
                written = 0
                if on_progress is not None:
                    # A failed attempt discards its partial file, so reset the
                    # visible progress before the retry starts from zero.
                    on_progress(written)
                with urllib.request.urlopen(request, timeout=STALL_SECONDS + 30) as response, part.open("wb") as output:
                    while True:
                        if cancel_event is not None and cancel_event.is_set():
                            raise CancellationError("The model download was canceled.")
                        chunk = response.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        output.write(chunk)
                        written += len(chunk)
                        if on_progress is not None:
                            on_progress(written)
                if size > 0 and part.stat().st_size != size:
                    raise ModelDownloadError(
                        f"Downloaded {filename} is {part.stat().st_size} bytes, expected {size}."
                    )
                os.replace(part, destination)
                return
            except CancellationError:
                _unlink(part)
                raise
            except (urllib.error.URLError, TimeoutError, OSError, ModelDownloadError) as exc:
                last_error = exc
                _unlink(part)
                if attempt == 0:
                    time.sleep(1.0)
                    continue
        raise ModelDownloadError(f"Could not download {filename} from {repo_id}: {last_error}")


def _unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _completed(root: Path) -> int:
    total = 0
    try:
        for item in root.rglob("*"):
            try:
                if item.is_file() and not item.name.endswith(".part"):
                    total += item.stat().st_size
            except OSError:
                continue
    except OSError:
        return 0
    return total


def _percent(downloaded: int, total: int) -> int | None:
    if total <= 0:
        return None
    return max(0, min(100, int(downloaded * 100 / total)))


def _free_bytes(path: Path) -> int:
    try:
        return int(shutil.disk_usage(path).free)
    except OSError:
        return 0
