from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from asr.audio import DecodedAudio
from asr.backends.base import ASRBackend
from asr.config import ASRConfig
from asr.errors import ASRError, CancellationError, ModelDownloadError
from asr.manager import ASRManager
from asr.registry import get_spec
from asr.schemas import Segment, Token, Word


class FakeBackend(ASRBackend):
    backend_name = "fake"
    supports_word_timestamps = True
    supports_token_timestamps = True
    supports_segment_timestamps = True

    def __init__(self, spec, config, store):
        super().__init__(spec, config, store)
        self.calls = 0
        self.languages = []

    def load(self, progress=None, cancel_event=None):
        self._loaded = True
        self.effective_device = "cpu"
        self.effective_compute_type = "float32"
        self.load_seconds = 0.01

    def transcribe(self, audio, sample_rate, *, language=None, word_timestamps=False, vad=True, cancel_event=None):
        self.calls += 1
        self.languages.append(language)
        duration = len(audio) / float(sample_rate)
        return self._result(
            text=f"piece {self.calls}",
            language="en",
            segments=[Segment(text="piece", start=0.0, end=duration)],
            words=[Word(text="piece", start=0.0, end=duration)],
            tokens=[Token(text="pie", start=0.0, end=duration / 2), Token(text="ce", start=duration / 2, end=duration)],
            duration_seconds=duration,
        )


class ManagerTests(unittest.TestCase):
    def make_manager(self, **overrides) -> ASRManager:
        directory = tempfile.mkdtemp()
        values = {
            "model": "parakeet-tdt-0.6b-v3",
            "device": "cpu",
            "cache_dir": directory,
            "chunk_seconds": 1.0,
        }
        values.update(overrides)
        return ASRManager(ASRConfig(**values))

    def load_fake(self, manager: ASRManager) -> FakeBackend:
        backend = FakeBackend(get_spec(manager.config.model), manager.config, manager.store)
        with mock.patch("asr.manager.availability", return_value={"available": True, "missing": [], "outdated": [], "reason": ""}), \
             mock.patch("asr.manager.create_backend", return_value=backend):
            manager.request_load()
            manager.wait_until_ready(timeout=5)
        return backend

    def test_load_and_transcribe_chunked_audio_offsets_timestamps(self) -> None:
        manager = self.make_manager()
        try:
            backend = self.load_fake(manager)
            audio = np.zeros(16000 * 2 + 8000, dtype=np.float32)
            result = manager.transcribe_audio(
                audio,
                16000,
                word_timestamps=True,
                vad=False,
                auto_load=False,
            )
            self.assertEqual(backend.calls, 3)
            self.assertTrue(result.text.startswith("piece"))
            self.assertEqual(len(result.segments), 3)
            self.assertEqual(len(result.words), 3)
            self.assertEqual(len(result.tokens), 6)
            self.assertAlmostEqual(result.words[1].start, 1.0, places=3)
            self.assertAlmostEqual(result.tokens[2].start, 1.0, places=3)
            self.assertIn("chunks", result.metadata)
            self.assertEqual(result.metadata["chunks"], 3)
            self.assertTrue(result.timings.audio_seconds > 2.4)
        finally:
            manager.shutdown()

    def test_max_audio_limit_is_enforced(self) -> None:
        manager = self.make_manager(max_audio_seconds=1.0)
        try:
            self.load_fake(manager)
            with self.assertRaises(ASRError):
                manager.transcribe_audio(np.zeros(32000, dtype=np.float32), 16000, auto_load=False)
        finally:
            manager.shutdown()

    def test_transcribe_bytes_forwards_auto_load(self) -> None:
        # The HTTP service passes auto_load=False and must never trigger an
        # implicit load or download. This guards the keyword against silently
        # regressing into a TypeError that the service masks as a 500.
        manager = self.make_manager()
        decoded = DecodedAudio(
            audio=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            channels=1,
            decoder="test",
        )
        sentinel = object()
        try:
            with mock.patch("asr.manager.decode_audio", return_value=decoded), \
                 mock.patch.object(manager, "transcribe_audio", return_value=sentinel) as transcribe:
                result = manager.transcribe_bytes(b"audio", auto_load=False, use_config_language=False)
            self.assertIs(result, sentinel)
            self.assertIs(transcribe.call_args.kwargs["auto_load"], False)
            self.assertIs(transcribe.call_args.kwargs["use_config_language"], False)
            self.assertIs(transcribe.call_args.kwargs["decoded"], decoded)
        finally:
            manager.shutdown()

    def test_use_config_language_can_be_disabled(self) -> None:
        manager = self.make_manager(language="en")
        try:
            backend = self.load_fake(manager)
            audio = np.zeros(16000, dtype=np.float32)
            manager.transcribe_audio(audio, 16000, auto_load=False, use_config_language=False)
            self.assertIsNone(backend.languages[-1])
            manager.transcribe_audio(audio, 16000, auto_load=False)
            self.assertEqual(backend.languages[-1], "en")
        finally:
            manager.shutdown()

    def test_wait_until_ready_honors_cancellation(self) -> None:
        manager = self.make_manager()
        event = threading.Event()
        event.set()
        try:
            with self.assertRaises(CancellationError):
                manager.wait_until_ready(cancel_event=event)
        finally:
            manager.shutdown()

    def test_unload_returns_to_idle(self) -> None:
        manager = self.make_manager()
        try:
            self.load_fake(manager)
            status = manager.unload()
            self.assertEqual(status["status"], "idle")
            self.assertIsNone(status["active_model"])
        finally:
            manager.shutdown()

    def test_request_download_tracks_background_progress(self) -> None:
        manager = self.make_manager(model="granite-speech-5.0-470m-turboctc")
        model_id = "granite-speech-5.0-470m-turboctc"
        model_dir = Path(manager.config.cache_dir) / "models" / model_id
        entered = threading.Event()
        release = threading.Event()

        def report(status, **fields):
            manager.store._set(model=model_id, status=status, **fields)

        def fake_resolve(spec, cancel_event=None):
            report("preparing")
            report(
                "downloading",
                downloaded_bytes=5,
                total_bytes=10,
                percent=50,
                current_file="model.safetensors",
            )
            entered.set()
            self.assertTrue(release.wait(5.0))
            report("complete", downloaded_bytes=10, total_bytes=10, percent=100)
            model_dir.mkdir(parents=True, exist_ok=True)
            (model_dir / "config.json").write_text("{}", encoding="utf-8")
            (model_dir / "model.safetensors").write_bytes(b"x")
            return model_dir

        try:
            with mock.patch.object(manager.store, "existing_path", return_value=None), \
                 mock.patch.object(manager.store, "resolve", side_effect=fake_resolve):
                started = manager.request_download()
                self.assertTrue(started["ok"])
                self.assertEqual(started["status"], "downloading")
                self.assertTrue(entered.wait(2.0))
                status = manager.status()
                self.assertEqual(status["status"], "downloading")
                self.assertTrue(status["download_active"])
                self.assertEqual(status["progress"]["percent"], 50)
                self.assertEqual(status["progress"]["downloaded_bytes"], 5)
                self.assertFalse(status["error"])
                release.set()
                deadline = time.monotonic() + 5
                while manager.status()["download_active"] and time.monotonic() < deadline:
                    time.sleep(0.02)
                status = manager.status()
            self.assertFalse(status["download_active"])
            self.assertEqual(status["status"], "idle")
            self.assertFalse(status["error"])
            self.assertFalse(status["download_error"])
            self.assertIsNone(status["active_model"])
        finally:
            release.set()
            manager.shutdown()

    def test_canceled_standalone_download_reports_canceled(self) -> None:
        manager = self.make_manager(model="granite-speech-5.0-470m-turboctc")
        model_id = "granite-speech-5.0-470m-turboctc"
        entered = threading.Event()

        def fake_resolve(spec, cancel_event=None):
            manager.store._set(
                model=model_id,
                status="downloading",
                downloaded_bytes=5,
                total_bytes=10,
                percent=50,
            )
            entered.set()
            self.assertTrue(cancel_event.wait(5.0))
            manager.store._set(
                model=model_id,
                status="canceled",
                error="The model download was canceled.",
            )
            raise CancellationError("The model download was canceled.")

        try:
            with mock.patch.object(manager.store, "existing_path", return_value=None), \
                 mock.patch.object(manager.store, "resolve", side_effect=fake_resolve):
                manager.request_download()
                self.assertTrue(entered.wait(2.0))
                canceled = manager.cancel()
                self.assertEqual(canceled["status"], "canceled")
                deadline = time.monotonic() + 5
                while manager.status()["download_active"] and time.monotonic() < deadline:
                    time.sleep(0.02)
                status = manager.status()
            self.assertEqual(status["status"], "canceled")
            self.assertIn("canceled", status["error"])
            self.assertFalse(status["download_active"])
        finally:
            manager.shutdown()

    def test_failed_standalone_download_reports_error(self) -> None:
        manager = self.make_manager(model="granite-speech-5.0-470m-turboctc")
        model_id = "granite-speech-5.0-470m-turboctc"
        entered = threading.Event()

        def fake_resolve(spec, cancel_event=None):
            manager.store._set(
                model=model_id,
                status="downloading",
                downloaded_bytes=1,
                total_bytes=10,
                percent=10,
            )
            entered.set()
            raise ModelDownloadError("Not enough disk space for the demo model.")

        try:
            with mock.patch.object(manager.store, "existing_path", return_value=None), \
                 mock.patch.object(manager.store, "resolve", side_effect=fake_resolve):
                manager.request_download()
                self.assertTrue(entered.wait(2.0))
                deadline = time.monotonic() + 5
                while manager.status()["download_active"] and time.monotonic() < deadline:
                    time.sleep(0.02)
                status = manager.status()
            self.assertEqual(status["status"], "error")
            self.assertIn("disk space", status["error"])
            self.assertIn("disk space", status["download_error"])
            self.assertFalse(status["download_active"])
        finally:
            manager.shutdown()

    def test_load_download_completion_moves_to_loading_not_idle(self) -> None:
        manager = self.make_manager(model="granite-speech-5.0-470m-turboctc")
        model_id = "granite-speech-5.0-470m-turboctc"
        manager._loading = True
        manager._target_model = model_id
        manager._state.update({"status": "preparing", "model": model_id, "target_model": model_id})
        try:
            manager.store._set(
                model=model_id,
                status="downloading",
                downloaded_bytes=5,
                total_bytes=10,
                percent=50,
            )
            self.assertEqual(manager.status()["status"], "downloading")
            manager.store._set(
                model=model_id,
                status="complete",
                downloaded_bytes=10,
                total_bytes=10,
                percent=100,
            )
            self.assertEqual(manager.status()["status"], "loading")
        finally:
            manager.shutdown()

    def test_status_reads_download_progress_without_the_manager_lock(self) -> None:
        manager = self.make_manager()
        try:
            def fake_store_status():
                result: list[bool] = []

                def probe() -> None:
                    acquired = manager._lock.acquire(timeout=0.5)
                    result.append(acquired)
                    if acquired:
                        manager._lock.release()

                thread = threading.Thread(target=probe)
                thread.start()
                thread.join(1.0)
                return {"probe": bool(result and result[0])}

            with mock.patch.object(manager.store, "status", side_effect=fake_store_status):
                status = manager.status()
            self.assertTrue(status["progress"]["probe"])
        finally:
            manager.shutdown()

    def test_unknown_model_is_rejected(self) -> None:
        manager = self.make_manager()
        try:
            with self.assertRaises(ASRError):
                manager.request_load("not-a-model")
        finally:
            manager.shutdown()


if __name__ == "__main__":
    unittest.main()
