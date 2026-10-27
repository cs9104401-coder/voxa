from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from asr.audio import (
    MAX_AUDIO_BYTES,
    chunk_audio,
    decode_audio,
    is_silent,
    read_wav_metadata,
    write_wav,
)
from asr.errors import AudioInputError


class AudioTests(unittest.TestCase):
    def test_wav_roundtrip_and_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            duration = 1.25
            rate = 16000
            samples = (0.1 * np.sin(2 * np.pi * 440 * np.arange(int(rate * duration)) / rate)).astype(np.float32)
            path = write_wav(Path(directory) / "tone.wav", samples, rate)
            metadata = read_wav_metadata(path)
            self.assertEqual(metadata["sample_rate"], rate)
            self.assertAlmostEqual(metadata["duration_seconds"], duration, places=2)
            decoded = decode_audio(path, 16000)
            self.assertEqual(decoded.sample_rate, 16000)
            self.assertEqual(decoded.channels, 1)
            self.assertAlmostEqual(decoded.duration_seconds, duration, places=2)
            self.assertEqual(decoded.audio.dtype, np.float32)
            self.assertGreater(float(np.max(np.abs(decoded.audio))), 0.05)

    def test_invalid_file_is_rejected(self) -> None:
        with self.assertRaises(AudioInputError):
            decode_audio(b"this is not audio")

    def test_empty_file_is_rejected(self) -> None:
        with self.assertRaises(AudioInputError):
            decode_audio(b"")

    def test_too_short_audio_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = write_wav(Path(directory) / "short.wav", np.zeros(100, dtype=np.float32), 16000)
            with self.assertRaises(AudioInputError):
                decode_audio(path)

    def test_chunks_cover_the_whole_signal(self) -> None:
        audio = np.arange(48000, dtype=np.float32) / 48000.0
        chunks = list(chunk_audio(audio, 16000, 1.0))
        self.assertEqual(len(chunks), 3)
        self.assertEqual(chunks[0].start, 0.0)
        self.assertEqual(chunks[-1].end, 3.0)
        self.assertEqual(sum(chunk.audio.size for chunk in chunks), audio.size)

    def test_chunk_overlap_is_validated(self) -> None:
        with self.assertRaises(AudioInputError):
            list(chunk_audio(np.zeros(16000, dtype=np.float32), 16000, 1.0, overlap_seconds=1.0))

    def test_silence_detection(self) -> None:
        self.assertTrue(is_silent(np.zeros(1000, dtype=np.float32)))
        self.assertFalse(is_silent(np.full(1000, 0.5, dtype=np.float32)))

    def test_size_limit_is_exposed(self) -> None:
        self.assertGreaterEqual(MAX_AUDIO_BYTES, 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
