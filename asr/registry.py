"""Lazy model registry. No inference framework is imported while listing models."""

from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
from dataclasses import dataclass, field
from typing import Any

from .errors import BackendUnavailableError, UnsupportedModelError


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    repo_id: str | None
    module: str
    class_name: str
    backend: str
    languages: tuple[str, ...] = ()
    capabilities: dict[str, bool] = field(default_factory=dict)
    dependencies: tuple[tuple[str, str, str | None], ...] = ()
    approx_size_bytes: int = 0
    required_files: tuple[str, ...] = ("config.json",)
    required_weight_prefixes: tuple[str, ...] = ("model.safetensors", "pytorch_model.bin")
    requires_index: bool = False
    cache_names: tuple[str, ...] = ()
    long_form: bool = False
    language_detection: bool = False
    word_timestamps: bool = False
    token_timestamps: bool = False
    notes: str = ""
    aliases: tuple[str, ...] = ()
    optional: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "repo_id": self.repo_id,
            "backend": self.backend,
            "languages": list(self.languages),
            "capabilities": dict(self.capabilities),
            "approx_size_bytes": self.approx_size_bytes,
            "notes": self.notes,
            "optional": self.optional,
            "cache_names": list(self.cache_names),
            "long_form": self.long_form,
        }


# Capability names are deliberately explicit: models without native streaming or
# timestamps must never be presented as if they had them.
def _caps(
    *,
    word_timestamps: bool,
    segments: bool,
    language_detection: bool,
    token_timestamps: bool = False,
    native_streaming: bool = False,
    partial_results: bool = False,
    quantization: bool = False,
    long_form: bool = False,
) -> dict[str, bool]:
    return {
        "file": True,
        "microphone_chunked": True,
        "native_streaming": native_streaming,
        "partial_results": partial_results,
        "long_form": long_form,
        "word_timestamps": word_timestamps,
        "token_timestamps": token_timestamps,
        "segment_timestamps": segments,
        "language_detection": language_detection,
        "quantization": quantization,
    }


_WHISPER_DEPS = (
    ("faster_whisper", "faster-whisper", "1.2.1"),
    ("ctranslate2", "ctranslate2", None),
)

SPECS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="parakeet-tdt-0.6b-v3",
        label="NVIDIA Parakeet TDT 0.6B v3",
        repo_id="nvidia/parakeet-tdt-0.6b-v3",
        module="asr.backends.parakeet",
        class_name="ParakeetBackend",
        backend="transformers-tdt",
        languages=(
            "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
            "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
        ),
        capabilities=_caps(
            word_timestamps=False,
            token_timestamps=True,
            segments=False,
            language_detection=False,
        ),
        dependencies=(
            ("torch", "torch", "2.0"),
            ("transformers", "transformers", "5.20.0"),
            ("librosa", "librosa", "0.10"),
        ),
        approx_size_bytes=2_508_311_120,
        required_files=("config.json", "processor_config.json", "tokenizer.json"),
        required_weight_prefixes=("model.safetensors",),
        language_detection=False,
        word_timestamps=False,
        token_timestamps=True,
        notes=(
            "Official Transformers AutoModelForTDT path. The processor exposes token-level "
            "timestamps, not word-level timestamps. The model selects a language internally "
            "but this path does not return a language label."
        ),
        aliases=("parakeet", "parakeet-tdt", "nvidia-parakeet"),
        optional=True,
    ),
    ModelSpec(
        id="qwen3-asr-1.7b",
        label="Qwen3-ASR 1.7B",
        repo_id="Qwen/Qwen3-ASR-1.7B",
        module="asr.backends.qwen3_asr",
        class_name="Qwen3ASRBackend",
        backend="qwen-asr",
        languages=(
            "zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th",
            "vi", "ja", "tr", "hi", "ms", "nl", "sv", "da", "fi", "pl", "cs", "fil", "fa",
            "el", "hu", "mk", "ro",
        ),
        capabilities=_caps(
            word_timestamps=False,
            segments=False,
            language_detection=True,
            long_form=True,
        ),
        dependencies=(
            ("torch", "torch", "2.0"),
            ("qwen_asr", "qwen-asr", "0.0.6"),
        ),
        approx_size_bytes=4_700_000_000,
        required_files=(
            "config.json",
            "preprocessor_config.json",
            "tokenizer_config.json",
            "vocab.json",
            "merges.txt",
        ),
        required_weight_prefixes=("model*.safetensors",),
        requires_index=True,
        long_form=True,
        language_detection=True,
        word_timestamps=False,
        notes=(
            "Official qwen-asr backend. Qwen recommends Python 3.12 and a fresh environment; "
            "qwen-asr 0.0.6 pins transformers 4.57.6, so this backend must live in its own "
            "VOXA_ASR_PYTHON environment. Word timestamps require the separate "
            "Qwen3-ForcedAligner-0.6B and are disabled by default. Native streaming uses vLLM "
            "and is not enabled here."
        ),
        aliases=("qwen", "qwen3", "qwen3-asr", "qwen-asr-1.7b"),
        optional=True,
    ),
    ModelSpec(
        id="granite-speech-5.0-470m-turboctc",
        label="IBM Granite Speech 5.0 470M TurboCTC",
        repo_id="ibm-granite/granite-speech-5.0-470m-turboctc",
        module="asr.backends.granite_speech",
        class_name="GraniteSpeechBackend",
        backend="granite-transformers",
        languages=("en", "fr", "de", "es", "pt", "it", "ja"),
        capabilities=_caps(word_timestamps=False, segments=False, language_detection=False),
        dependencies=(
            ("torch", "torch", "2.0"),
            ("transformers", "transformers", "5.16.0"),
            ("torchaudio", "torchaudio", "2.6"),
        ),
        approx_size_bytes=946_311_576,
        required_files=("config.json", "processor_config.json", "tokenizer.json"),
        required_weight_prefixes=("model.safetensors",),
        language_detection=False,
        word_timestamps=False,
        notes=(
            "Official transformers>=5.16.0 AutoModelForCTC path with greedy CTC decoding. "
            "The model returns punctuated text but no timestamps and no language label."
        ),
        aliases=("granite", "granite-speech", "granite-turboctc"),
        optional=True,
    ),
    ModelSpec(
        id="whisper-large-v3-turbo",
        label="Whisper large-v3-turbo",
        repo_id="mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        module="asr.backends.faster_whisper",
        class_name="FasterWhisperBackend",
        backend="faster-whisper",
        languages=("multilingual",),
        capabilities=_caps(
            word_timestamps=True,
            segments=True,
            language_detection=True,
            quantization=True,
        ),
        dependencies=_WHISPER_DEPS,
        approx_size_bytes=1_620_000_000,
        required_files=("config.json", "model.bin", "tokenizer.json"),
        required_weight_prefixes=("model.bin",),
        cache_names=("large-v3-turbo",),
        language_detection=True,
        word_timestamps=True,
        notes="faster-whisper/CTranslate2 backend. CPU int8 fallback and optional CUDA float16.",
        aliases=("whisper-turbo", "large-v3-turbo", "turbo"),
    ),
    ModelSpec(
        id="whisper-large-v3",
        label="Whisper large-v3",
        repo_id="Systran/faster-whisper-large-v3",
        module="asr.backends.faster_whisper",
        class_name="FasterWhisperBackend",
        backend="faster-whisper",
        languages=("multilingual",),
        capabilities=_caps(
            word_timestamps=True,
            segments=True,
            language_detection=True,
            quantization=True,
        ),
        dependencies=_WHISPER_DEPS,
        approx_size_bytes=3_090_000_000,
        required_files=("config.json", "model.bin", "tokenizer.json"),
        required_weight_prefixes=("model.bin",),
        cache_names=("large-v3",),
        language_detection=True,
        word_timestamps=True,
        notes="Compatibility entry for the model Voxa already ships and caches.",
        aliases=("large-v3",),
    ),
    ModelSpec(
        id="whisper-small",
        label="Whisper small",
        repo_id="Systran/faster-whisper-small",
        module="asr.backends.faster_whisper",
        class_name="FasterWhisperBackend",
        backend="faster-whisper",
        languages=("multilingual",),
        capabilities=_caps(
            word_timestamps=True,
            segments=True,
            language_detection=True,
            quantization=True,
        ),
        dependencies=_WHISPER_DEPS,
        approx_size_bytes=484_190_939,
        required_files=("config.json", "model.bin", "tokenizer.json"),
        required_weight_prefixes=("model.bin",),
        cache_names=("small",),
        language_detection=True,
        word_timestamps=True,
        notes="Smaller compatibility entry used for tests and offline setups.",
        aliases=("small",),
    ),
    ModelSpec(
        id="whisper-base",
        label="Whisper base",
        repo_id="Systran/faster-whisper-base",
        module="asr.backends.faster_whisper",
        class_name="FasterWhisperBackend",
        backend="faster-whisper",
        languages=("multilingual",),
        capabilities=_caps(
            word_timestamps=True,
            segments=True,
            language_detection=True,
            quantization=True,
        ),
        dependencies=_WHISPER_DEPS,
        approx_size_bytes=145_466_455,
        required_files=("config.json", "model.bin", "tokenizer.json"),
        required_weight_prefixes=("model.bin",),
        cache_names=("base",),
        language_detection=True,
        word_timestamps=True,
        notes="Compatibility entry for Voxa's existing base model.",
        aliases=("base",),
    ),
    ModelSpec(
        id="whisper-tiny",
        label="Whisper tiny",
        repo_id="Systran/faster-whisper-tiny",
        module="asr.backends.faster_whisper",
        class_name="FasterWhisperBackend",
        backend="faster-whisper",
        languages=("multilingual",),
        capabilities=_caps(
            word_timestamps=True,
            segments=True,
            language_detection=True,
            quantization=True,
        ),
        dependencies=_WHISPER_DEPS,
        approx_size_bytes=75_525_797,
        required_files=("config.json", "model.bin", "tokenizer.json"),
        required_weight_prefixes=("model.bin",),
        cache_names=("tiny",),
        language_detection=True,
        word_timestamps=True,
        notes="Compatibility entry for Voxa's existing tiny model.",
        aliases=("tiny",),
    ),
)

_ALIASES: dict[str, str] = {}
for _spec in SPECS:
    _ALIASES[_spec.id.lower()] = _spec.id
    for _alias in _spec.aliases:
        _ALIASES[_alias.lower()] = _spec.id

# These ids are accepted by the application but are served by the already-running
# Whisper manager rather than the new ASR manager.
APP_WHISPER_ENGINES = frozenset({"whisper", "local-whisper"})


def get_spec(model_id: str) -> ModelSpec:
    key = str(model_id or "").strip()
    if not key:
        raise UnsupportedModelError("Choose an ASR model.")
    resolved = _ALIASES.get(key.lower())
    if not resolved:
        known = ", ".join(spec.id for spec in SPECS)
        raise UnsupportedModelError(f"Unknown ASR model '{key}'. Supported models: {known}.")
    return next(spec for spec in SPECS if spec.id == resolved)


def list_specs() -> list[ModelSpec]:
    return list(SPECS)


def dependency_status(dependencies: tuple[tuple[str, str, str | None], ...]) -> dict[str, Any]:
    missing: list[str] = []
    outdated: list[str] = []
    for module, package, minimum in dependencies:
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, ModuleNotFoundError, ValueError):
            found = False
        if not found:
            missing.append(package)
            continue
        if minimum:
            try:
                installed = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                # Some packages expose a module without a matching distribution name.
                continue
            try:
                from packaging.version import Version

                if Version(installed) < Version(minimum):
                    outdated.append(f"{package}>={minimum} (installed {installed})")
            except Exception:
                # Version comparison must never make a usable backend disappear.
                pass
    return {"available": not missing and not outdated, "missing": missing, "outdated": outdated}


def availability(spec: ModelSpec) -> dict[str, Any]:
    status = dependency_status(spec.dependencies)
    if status["available"]:
        return {**status, "reason": ""}
    parts = []
    if status["missing"]:
        parts.append("missing: " + ", ".join(status["missing"]))
    if status["outdated"]:
        parts.append("requires: " + ", ".join(status["outdated"]))
    return {**status, "reason": "; ".join(parts)}


def create_backend(spec: ModelSpec, config: Any, store: Any):
    requested = str(config.backend or "auto").lower()
    if requested not in ("auto", "transformers") and requested != spec.backend:
        raise UnsupportedModelError(
            f"Model '{spec.id}' requires backend '{spec.backend}', not '{config.backend}'."
        )
    if requested == "transformers" and spec.backend not in {"transformers-tdt", "granite-transformers"}:
        raise UnsupportedModelError(
            f"The 'transformers' backend alias is only valid for Parakeet TDT and Granite CTC, not '{spec.id}'."
        )
    status = availability(spec)
    if not status["available"]:
        raise BackendUnavailableError(
            f"{spec.label} is not installed in this Python environment ({status['reason']}). "
            f"Install the optional requirements file for this backend and restart the ASR service."
        )
    try:
        module = importlib.import_module(spec.module)
        backend_class = getattr(module, spec.class_name)
    except (ImportError, AttributeError) as exc:
        raise BackendUnavailableError(
            f"The backend module for {spec.label} could not be loaded: {exc}"
        ) from exc
    return backend_class(spec=spec, config=config, store=store)
