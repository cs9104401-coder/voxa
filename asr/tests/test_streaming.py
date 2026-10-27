from __future__ import annotations

import tempfile
import threading
import unittest

import numpy as np

from asr.config import ASRConfig
from asr.errors import AudioInputError, CancellationError
from asr.streaming import capture_utterance, iter_chunked

BLOCK = 480


class FakeStream:
    def __init__(self, blocks):
        self._blocks = list(blocks)
        self._index = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size):
        if self._index >= len(self._blocks):
            return np.zeros(size, dtype=np.float32)
        block = self._blocks[self._index]
        self._index += 1
        return block


def fake_sounddevice(blocks):
    class InputStream:
        def __init__(self, **_kwargs):
            pass

        def __new__(cls, **_kwargs):
            return FakeStream(blocks)

    return type("FakeSoundDevice", (), {"InputStream": InputStream})


class StreamingTests(unittest.TestCase):
    def config(self, **overrides):
        values = {"cache_dir": tempfile.gettempdir(), "device": "cpu"}
        values.update(overrides)
        return ASRConfig(**values)

    def test_capture_stops_after_silence(self) -> None:
        speech = [np.full(BLOCK, 0.1, dtype=np.float32)] * 12
        silence = [np.zeros(BLOCK, dtype=np.float32)] * 40
        captured = capture_utterance(
            self.config(),
            sounddevice_module=fake_sounddevice(speech + silence),
            threshold=0.005,
            start_timeout=5.0,
            silence_ms=300,
            max_seconds=10.0,
        )
        self.assertTrue(captured.speech_detected)
        self.assertGreater(captured.duration_seconds, 0.5)
        self.assertLess(captured.duration_seconds, 5.0)
        self.assertGreater(captured.peak_rms, 0.05)

    def test_no_speech_raises(self) -> None:
        silence = [np.zeros(BLOCK, dtype=np.float32)] * 100
        with self.assertRaises(AudioInputError):
            capture_utterance(
                self.config(),
                sounddevice_module=fake_sounddevice(silence),
                start_timeout=0.15,
                silence_ms=300,
                max_seconds=2.0,
            )

    def test_capture_can_be_cancelled(self) -> None:
        event = threading.Event()
        event.set()
        with self.assertRaises(CancellationError):
            capture_utterance(
                self.config(),
                sounddevice_module=fake_sounddevice([np.zeros(BLOCK, dtype=np.float32)] * 10),
                cancel_event=event,
                start_timeout=2.0,
            )

    def test_iter_chunked_offsets(self) -> None:
        audio = np.zeros(16000 * 2 + 100, dtype=np.float32)
        chunks = list(iter_chunked(audio, 16000, 1.0))
        self.assertEqual([chunk[0] for chunk in chunks], [0, 1, 2])
        self.assertEqual(chunks[-1][1], 2.0)
        self.assertAlmostEqual(chunks[-1][2], 2.00625, places=4)


if __name__ == "__main__":
    unittest.main()
