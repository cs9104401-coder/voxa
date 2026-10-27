from __future__ import annotations

import tempfile
import unittest

from fastapi.testclient import TestClient

from asr.config import ASRConfig
from asr.schemas import TranscriptionResult
from asr.service import create_app


class FakeManager:
    def __init__(self):
        self.loaded = []
        self.downloaded = []
        self.shutdown_called = False
        self.status_calls = 0
        self.transcribed_kwargs = []

    def status(self):
        self.status_calls += 1
        return {
            "ok": False,
            "service": "asr",
            "status": "idle",
            "selected_model": "parakeet-tdt-0.6b-v3",
            "target_model": "parakeet-tdt-0.6b-v3",
            "active_model": None,
            "available": True,
            "downloaded": False,
            "progress": {"status": "idle"},
        }

    def list_models(self):
        return [{"id": "parakeet-tdt-0.6b-v3", "label": "Parakeet", "available": True}]

    def request_load(self, model, *, device=None, compute_type=None, language=None):
        self.loaded.append((model, device, compute_type, language))
        return {"status": "preparing", "target_model": model}

    def request_download(self, model):
        self.downloaded.append(model)
        return {"ok": True, "model": model, "status": "downloading"}

    def cancel(self):
        return {"status": "canceled"}

    def unload(self):
        return {"status": "idle"}

    def transcribe_bytes(self, data, **kwargs):
        self.transcribed_kwargs.append(dict(kwargs))
        if data == b"empty":
            from asr.errors import AudioInputError

            raise AudioInputError("empty")
        return TranscriptionResult(
            text="hello",
            model_id=kwargs.get("model_id") or "parakeet-tdt-0.6b-v3",
            backend="transformers-tdt",
            device="cpu",
            language=None,
            duration_seconds=1.0,
        )

    def shutdown(self):
        self.shutdown_called = True


class ServiceTests(unittest.TestCase):
    def app(self, token: str | None = None):
        config = ASRConfig(
            model="parakeet-tdt-0.6b-v3",
            device="cpu",
            cache_dir=tempfile.mkdtemp(),
            service_token=token,
        )
        manager = FakeManager()
        return create_app(config, manager), manager

    def test_health_is_local_and_structured(self) -> None:
        app, _manager = self.app()
        with TestClient(app) as client:
            response = client.get("/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["service"], "asr")
        self.assertIn("status", payload)
        self.assertNotIn("service_token", payload["config"])

    def test_token_is_required_when_configured(self) -> None:
        app, _manager = self.app(token="abc123")
        with TestClient(app) as client:
            self.assertEqual(client.get("/health").status_code, 401)
            self.assertEqual(client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code, 401)
            self.assertEqual(client.get("/health", headers={"Authorization": "Bearer abc123"}).status_code, 200)
            self.assertEqual(client.get("/health", headers={"X-Voxa-ASR-Token": "abc123"}).status_code, 200)

    def test_models_and_load_validation(self) -> None:
        app, manager = self.app()
        with TestClient(app) as client:
            self.assertEqual(client.get("/models").status_code, 200)
            ok = client.post("/models/load", json={"model": "parakeet-tdt-0.6b-v3", "device": "cpu"})
            self.assertEqual(ok.status_code, 202)
            self.assertEqual(manager.loaded[0][0], "parakeet-tdt-0.6b-v3")
            bad = client.post("/models/load", json={"model": "nope"})
            self.assertEqual(bad.status_code, 422)
            self.assertEqual(bad.json()["error"]["code"], "unsupported_model")
            bad_device = client.post("/models/load", json={"model": "parakeet-tdt-0.6b-v3", "device": "tpu"})
            self.assertEqual(bad_device.status_code, 400)

    def test_download_and_cancel_status(self) -> None:
        app, manager = self.app()
        with TestClient(app) as client:
            response = client.post("/models/download", json={"model": "granite-speech-5.0-470m-turboctc"})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(manager.downloaded, ["granite-speech-5.0-470m-turboctc"])
            self.assertEqual(client.post("/models/cancel").status_code, 200)
            self.assertEqual(client.post("/models/unload").status_code, 200)
            cancel = client.post("/transcribe/cancel")
            self.assertEqual(cancel.status_code, 202)
            self.assertFalse(cancel.json()["canceled"])

    def test_transcribe_multipart(self) -> None:
        app, manager = self.app()
        with TestClient(app) as client:
            response = client.post(
                "/transcribe",
                files={"audio": ("clip.wav", b"RIFF....", "audio/wav")},
                data={"model": "parakeet-tdt-0.6b-v3", "vad": "false"},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["result"]["text"], "hello")
        self.assertEqual(payload["result"]["tokens"], None)
        # HTTP transcription must never auto-load or download a model and must
        # use the per-request language rather than the service launch default.
        self.assertIs(manager.transcribed_kwargs[0]["auto_load"], False)
        self.assertIs(manager.transcribed_kwargs[0]["use_config_language"], False)

    def test_empty_upload_is_structured(self) -> None:
        app, _manager = self.app()
        with TestClient(app) as client:
            response = client.post("/transcribe", files={"audio": ("clip.wav", b"", "audio/wav")})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "audio_input_error")

    def test_shutdown_calls_manager(self) -> None:
        app, manager = self.app()
        with TestClient(app) as client:
            client.get("/health")
        self.assertTrue(manager.shutdown_called)


if __name__ == "__main__":
    unittest.main()
