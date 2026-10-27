from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from asr.errors import CancellationError, ModelDownloadError
from asr.model_downloads import ModelStore, _percent, _safe_relative
from asr.registry import ModelSpec


def spec(**overrides) -> ModelSpec:
    values = dict(
        id="demo-model",
        label="Demo model",
        repo_id="example/demo-model",
        module="asr.backends.faster_whisper",
        class_name="FasterWhisperBackend",
        backend="faster-whisper",
        required_files=("config.json", "model.bin"),
        required_weight_prefixes=("model.bin",),
    )
    values.update(overrides)
    return ModelSpec(**values)


class ModelStoreTests(unittest.TestCase):
    def make_ready(self, root: Path, name: str) -> Path:
        model = root / "models" / name
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}", encoding="utf-8")
        (model / "model.bin").write_bytes(b"weights")
        return model

    def test_existing_model_is_found(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.make_ready(root, "demo-model")
            store = ModelStore(str(root))
            self.assertEqual(store.existing_path(spec()), expected)

    def test_cache_names_support_legacy_whisper_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.make_ready(root, "large-v3-turbo")
            store = ModelStore(str(root))
            whisper = spec(
                id="whisper-large-v3-turbo",
                cache_names=("large-v3-turbo",),
                required_files=("config.json", "model.bin"),
            )
            self.assertEqual(store.existing_path(whisper), expected)

    def test_incomplete_model_is_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "models" / "demo-model"
            model.mkdir(parents=True)
            (model / "config.json").write_text("{}", encoding="utf-8")
            store = ModelStore(str(root))
            self.assertIsNone(store.existing_path(spec()))

    def test_sharded_index_requires_every_shard(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "models" / "demo-model"
            model.mkdir(parents=True)
            (model / "config.json").write_text("{}", encoding="utf-8")
            (model / "tokenizer.json").write_text("{}", encoding="utf-8")
            (model / "model-00001-of-00002.safetensors").write_bytes(b"one")
            index = {"weight_map": {"a": "model-00001-of-00002.safetensors", "b": "model-00002-of-00002.safetensors"}}
            (model / "model.safetensors.index.json").write_text(json.dumps(index), encoding="utf-8")
            sharded = spec(
                required_files=("config.json", "tokenizer.json"),
                required_weight_prefixes=("model*.safetensors",),
                requires_index=True,
            )
            store = ModelStore(str(root))
            self.assertIsNone(store.existing_path(sharded))
            (model / "model-00002-of-00002.safetensors").write_bytes(b"two")
            self.assertEqual(store.existing_path(sharded), model)

    def test_offline_missing_model_raises(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ModelStore(directory, offline=True)
            with self.assertRaises(ModelDownloadError):
                store.resolve(spec())

    def test_compatibility_directory_is_searched(self) -> None:
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as legacy:
            expected = self.make_ready(Path(legacy), "large-v3-turbo")
            store = ModelStore(directory, compatibility_cache_dirs=(legacy,))
            whisper = spec(
                id="whisper-large-v3-turbo",
                cache_names=("large-v3-turbo",),
                required_files=("config.json", "model.bin"),
            )
            self.assertEqual(store.existing_path(whisper), expected)

    def test_download_progress_does_not_hold_the_state_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ModelStore(directory)
            lock_available: list[bool] = []

            def progress(_payload) -> None:
                result: list[bool] = []

                def probe() -> None:
                    acquired = store._lock.acquire(timeout=0.5)
                    result.append(acquired)
                    if acquired:
                        store._lock.release()

                thread = threading.Thread(target=probe)
                thread.start()
                thread.join(1.0)
                lock_available.append(bool(result and result[0]))

            def fake_download(_spec, _cancel_event):
                store._set(status="downloading")
                return Path(directory) / "models" / "demo-model"

            store.progress = progress
            with mock.patch.object(store, "_download", side_effect=fake_download):
                store.resolve(spec())
            self.assertEqual(lock_available, [True])

    def test_download_cancellation_publishes_terminal_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ModelStore(directory)
            with mock.patch.object(store, "_list_files", return_value=[("model.bin", 5)]), \
                 mock.patch("asr.model_downloads._free_bytes", return_value=10**9), \
                 mock.patch.object(store, "_fetch_file", side_effect=CancellationError("The model download was canceled.")):
                with self.assertRaises(CancellationError):
                    store.resolve(spec())
            status = store.status()
            self.assertEqual(status["status"], "canceled")
            self.assertIn("canceled", status["error"])
            self.assertEqual(status["speed_bps"], 0)
            self.assertFalse(status["stalled"])

    def test_download_failure_publishes_terminal_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ModelStore(directory)
            with mock.patch.object(store, "_list_files", return_value=[("model.bin", 5)]), \
                 mock.patch("asr.model_downloads._free_bytes", return_value=10**9), \
                 mock.patch.object(store, "_fetch_file", side_effect=ModelDownloadError("network failed")):
                with self.assertRaises(ModelDownloadError):
                    store.resolve(spec())
            status = store.status()
            self.assertEqual(status["status"], "error")
            self.assertIn("network failed", status["error"])
            self.assertEqual(status["speed_bps"], 0)
            self.assertFalse(status["stalled"])

    def test_fetch_file_reports_cumulative_progress(self) -> None:
        class FakeResponse:
            def __init__(self, chunks):
                self._chunks = iter(chunks)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return next(self._chunks, b"")

        with tempfile.TemporaryDirectory() as directory:
            store = ModelStore(directory)
            destination = Path(directory) / "model.bin"
            seen: list[int] = []
            with mock.patch("huggingface_hub.hf_hub_url", return_value="http://example.invalid/model.bin"), \
                 mock.patch("asr.model_downloads.urllib.request.urlopen", return_value=FakeResponse([b"aaa", b"bbbb"])):
                store._fetch_file(
                    "example/demo",
                    "model.bin",
                    destination,
                    7,
                    None,
                    on_progress=seen.append,
                )
            self.assertEqual(seen, [0, 3, 7])
            self.assertEqual(destination.read_bytes(), b"aaabbbb")

    def test_status_marks_a_stalled_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ModelStore(directory)
            store._set(model="demo-model", status="downloading", downloaded_bytes=10, total_bytes=100)
            self.assertFalse(store.status()["stalled"])
            store._last_progress_monotonic = time.monotonic() - 61
            self.assertTrue(store.status()["stalled"])
            store._set(downloaded_bytes=20)
            self.assertFalse(store.status()["stalled"])

    def test_safe_relative_filters_unsafe_and_irrelevant_files(self) -> None:
        self.assertEqual(_safe_relative("model.safetensors"), "model.safetensors")
        self.assertEqual(_safe_relative("nested/tokenizer.json"), "nested/tokenizer.json")
        for name in ("../escape.json", "README.md", "assets/plot.png", "model.sig", "folder/"):
            self.assertIsNone(_safe_relative(name), name)

    def test_percent_is_bounded(self) -> None:
        self.assertIsNone(_percent(0, 0))
        self.assertEqual(_percent(5, 10), 50)
        self.assertEqual(_percent(20, 10), 100)


if __name__ == "__main__":
    unittest.main()
