"""Shared audio decoding, validation, and chunking."""

from __future__ import annotations

import io
import math
import os
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

from .errors import ASRError, AudioInputError, DeviceUnavailableError

MAX_AUDIO_BYTES = 512 * 1024 * 1024
MIN_DURATION_SECONDS = 0.05


@dataclass
class DecodedAudio:
    audio: np.ndarray
    sample_rate: int
    duration_seconds: float
    channels: int
    decoder: str


@dataclass
class AudioChunk:
    index: int
    start: float
    end: float
    audio: np.ndarray


def _as_mono(array: np.ndarray) -> tuple[np.ndarray, int]:
    data = np.asarray(array)
    if data.ndim == 2:
        if data.shape[0] <= 8 and data.shape[1] > data.shape[0]:
            data = data.mean(axis=0)
        else:
            data = data.mean(axis=1)
    if data.ndim != 1:
        raise AudioInputError("The decoder returned an unexpected audio shape.")
    data = np.ascontiguousarray(data, dtype=np.float32)
    if data.size == 0:
        raise AudioInputError("Audio file is empty.")
    if not np.all(np.isfinite(data)):
        raise AudioInputError("Audio contains non-finite samples.")
    return data, 2 if np.asarray(array).ndim == 2 else 1


def _decode_with_av(raw: bytes, target_rate: int) -> tuple[np.ndarray, int, int]:
    import av  # type: ignore

    with av.open(io.BytesIO(raw), mode="r") as container:
        if not container.streams.audio:
            raise AudioInputError("The file does not contain an audio stream.")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=target_rate)
        pieces: list[np.ndarray] = []
        for frame in container.decode(stream):
            outputs = resampler.resample(frame)
            if outputs is None:
                continue
            if not isinstance(outputs, (list, tuple)):
                outputs = [outputs]
            for output in outputs:
                pieces.append(np.asarray(output.to_ndarray(), dtype=np.float32).reshape(-1))
        tail = resampler.resample(None)
        if tail:
            if not isinstance(tail, (list, tuple)):
                tail = [tail]
            for output in tail:
                pieces.append(np.asarray(output.to_ndarray(), dtype=np.float32).reshape(-1))
    if not pieces:
        raise AudioInputError("No audio frames could be decoded.")
    data = np.concatenate(pieces).astype(np.float32, copy=False)
    return data, target_rate, 1


def _decode_with_soundfile(raw: bytes, target_rate: int) -> tuple[np.ndarray, int, int]:
    import soundfile as sf  # type: ignore

    data, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    channels = int(data.shape[1]) if data.ndim == 2 else 1
    mono = data.mean(axis=1) if data.ndim == 2 else data
    if int(rate) != target_rate:
        # Linear resampling is a fallback only; PyAV normally handles resampling
        # with a proper filter. This keeps WAV/FLAC usable in minimal installs.
        source = np.asarray(mono, dtype=np.float32)
        duration = source.size / float(rate)
        target_size = max(1, int(round(duration * target_rate)))
        positions = np.linspace(0.0, max(0.0, duration - 1.0 / rate), target_size, dtype=np.float64)
        mono = np.interp(positions, np.arange(source.size) / float(rate), source).astype(np.float32)
    return np.asarray(mono, dtype=np.float32), target_rate, channels


def decode_audio(source: bytes | bytearray | memoryview | str | os.PathLike[str] | Path, target_rate: int = 16000) -> DecodedAudio:
    if isinstance(source, (str, os.PathLike, Path)):
        path = Path(source)
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise AudioInputError(f"Audio file could not be read: {exc}") from exc
        if size <= 0:
            raise AudioInputError("Audio file is empty.")
        if size > MAX_AUDIO_BYTES:
            raise AudioInputError("Audio file is larger than the 512 MB safety limit.")
        raw = path.read_bytes()
    else:
        raw = bytes(source)
    if not raw:
        raise AudioInputError("Audio file is empty.")
    if len(raw) > MAX_AUDIO_BYTES:
        raise AudioInputError("Audio file is larger than the 512 MB safety limit.")

    errors: list[str] = []
    audio: np.ndarray | None = None
    rate = target_rate
    channels = 1
    decoder = "av"
    try:
        audio, rate, channels = _decode_with_av(raw, target_rate)
    except Exception as exc:
        errors.append(f"PyAV: {exc}")
    if audio is None:
        try:
            audio, rate, channels = _decode_with_soundfile(raw, target_rate)
            decoder = "soundfile"
        except Exception as exc:
            errors.append(f"soundfile: {exc}")
            raise AudioInputError(
                "The audio could not be decoded. Supported inputs depend on the installed decoders "
                "(WAV/FLAC via soundfile; MP3/WebM/OGG via PyAV). " + " | ".join(errors)
            ) from exc

    audio, channels = _as_mono(audio)
    if rate != target_rate:
        raise AudioInputError(f"The decoder returned {rate} Hz instead of the requested {target_rate} Hz.")
    duration = float(audio.size) / float(target_rate)
    if duration < MIN_DURATION_SECONDS:
        raise AudioInputError("The recording is too short to transcribe.")
    if duration > 4 * 3600:
        raise AudioInputError("The recording is longer than the 4-hour safety limit.")
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 8.0:
        raise AudioInputError("Audio samples are outside the expected range.")
    return DecodedAudio(audio=audio, sample_rate=target_rate, duration_seconds=duration, channels=channels, decoder=decoder)


def is_silent(audio: np.ndarray, threshold: float = 0.002) -> bool:
    if audio.size == 0:
        return True
    rms = math.sqrt(float(np.mean(np.square(audio, dtype=np.float64))))
    return rms < threshold


def chunk_audio(
    audio: np.ndarray,
    sample_rate: int,
    chunk_seconds: float,
    overlap_seconds: float = 0.0,
) -> Iterator[AudioChunk]:
    if chunk_seconds <= 0:
        raise AudioInputError("Chunk seconds must be positive.")
    if overlap_seconds < 0 or overlap_seconds >= chunk_seconds:
        raise AudioInputError("Chunk overlap must be non-negative and smaller than the chunk.")
    size = max(1, int(round(chunk_seconds * sample_rate)))
    hop = max(1, int(round((chunk_seconds - overlap_seconds) * sample_rate)))
    total = int(audio.size)
    index = 0
    start = 0
    while start < total:
        end = min(total, start + size)
        yield AudioChunk(
            index=index,
            start=start / sample_rate,
            end=end / sample_rate,
            audio=np.ascontiguousarray(audio[start:end]),
        )
        if end >= total:
            break
        start += hop
        index += 1


def write_wav(path: str | os.PathLike[str], audio: np.ndarray, sample_rate: int = 16000) -> str:
    """Write 16-bit mono PCM for tests and diagnostics, never for microphone input."""
    data = np.asarray(audio, dtype=np.float32).reshape(-1)
    clipped = np.clip(data, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())
    return str(target)


def read_wav_metadata(path: str | os.PathLike[str]) -> dict[str, float | int]:
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            return {"frames": frames, "sample_rate": rate, "duration_seconds": frames / float(rate) if rate else 0.0}
    except (OSError, wave.Error) as exc:
        raise AudioInputError(f"Not a readable PCM WAV file: {exc}") from exc


def microphone_available() -> tuple[bool, str]:
    try:
        import sounddevice  # type: ignore  # noqa: F401
    except Exception as exc:
        return False, f"Microphone input needs the optional sounddevice package ({exc})."
    return True, ""


def open_microphone_stream(sample_rate: int = 16000, device: str | int | None = None, block_ms: int = 30):
    available, reason = microphone_available()
    if not available:
        raise DeviceUnavailableError(reason)
    import sounddevice as sd  # type: ignore

    try:
        return sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            blocksize=max(1, int(sample_rate * block_ms / 1000)),
            device=device,
        )
    except Exception as exc:
        raise DeviceUnavailableError(f"Could not open the microphone: {exc}") from exc
