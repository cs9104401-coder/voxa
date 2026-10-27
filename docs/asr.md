# Optional speech recognition engines

Voxa keeps the bundled faster-whisper server as the default local engine. This
document covers the optional, lazily started ASR service that can run four
additional backends without changing microphone capture, dictation, history, or
agent behavior:

| Engine | Backend | Languages | Native timestamps | Notes |
| --- | --- | --- | --- | --- |
| Whisper large-v3-turbo | faster-whisper | Automatic | Segments and words | Used through the bundled server by the app. Accepts an ISO language hint. The optional service also exposes it for the CLI and service tests. |
| NVIDIA Parakeet TDT 0.6B v3 | `transformers` `AutoModelForTDT` | 25 European languages | **Token timestamps only** | The model chooses a language internally but does not return a language label. **Language hints are ignored.** Tokens are never renamed to words. |
| Qwen3-ASR 1.7B | `qwen-asr` | 30 languages | Word/character timestamps only with the separate `Qwen3-ForcedAligner-0.6B` | Long-form audio and language detection are native. Accepts an ISO language hint. Needs its own Python environment. |
| IBM Granite Speech 5.0 470M TurboCTC | `transformers` `AutoModelForCTC` | English, French, German, Spanish, Portuguese, Italian, Japanese | None | Compact multilingual CTC model. No language label or timestamps. **Language hints are ignored.** |

The app never invents confidence, language, word timestamps, or segments. A
result field is present only when the selected backend actually produced it.

**Language hints.** The default **Speech language** is `en`. Bundled Whisper and
Qwen3-ASR pass the hint to the model; Parakeet and Granite choose the language
internally and ignore it. The dashboard marks the field and explains when the
selected engine ignores the hint. The same value also tells the assistant which
language to use for replies. The settings v8 migration moves installs that were
using an engine without language hints to bundled Whisper, so English speech is
not silently transcribed as another language. Clear the field to use automatic
detection.

## How the app uses it

- **Speech engine** on the **Dictation** page selects the engine. `Whisper
  (bundled)` is the default and keeps the existing server and cache untouched.
- Selecting an optional engine and saving does **not** start Python, load a
  model, or download anything. The service starts only when you press **Check
  status**, **Download model**, or **Load model**.
- **Download model** fetches one model into
  `%APPDATA%\my-voice-app\asr-models`. Progress is reported while each file is
  being written, including multi-gigabyte shards. **Load model** loads it and,
  if it is not cached, downloads it first. **Cancel** stops the current download
  or load. **Unload** releases the active model.
- Long inference runs in the main process's service process, not the dashboard
  thread. The existing recorder renderer still captures the microphone.
- Dictation uses the model that is already loaded. If the selected optional
  model is not loaded, Voxa asks you to press **Load model** instead of
  silently starting the service or downloading several gigabytes mid-recording.
- One local engine is active at a time. Switching from Whisper to an optional
  engine stops the bundled Whisper server. Switching back stops the optional
  service, waits for its process to exit, and preloads bundled Whisper again so
  the next dictation is ready. Switching between optional
  engines/devices/compute types/chunk sizes stops the optional service; it does
  not silently cancel a turn, download, or load. Saving is rejected while one
  is active. Optional models are never started by a settings save.
- An explicit CUDA request fails with a clear error when CUDA cannot be used.
  `Auto` may use CUDA when the installed runtime supports the GPU and otherwise
  uses CPU. "CUDA exists" and "the installed kernels support this GPU" are
  separate checks.
- A failed optional load never silently falls back to Whisper. The dashboard
  shows the backend error and the required environment file.

The optional service is separate from the bundled `voxa-whisper.exe` server.
Whisper-only installations continue to need no Python.

## Install an optional runtime

Use Python 3.11 or 3.12 on Windows. Keep each dependency family in its own
environment; do not install these into the bundled Whisper server.

### Parakeet or Granite (Transformers 5.x)

```powershell
py -3.11 -m venv whisper-server\.venv-asr
.\whisper-server\.venv-asr\Scripts\python.exe -m pip install --upgrade pip
.\whisper-server\.venv-asr\Scripts\python.exe -m pip install -r whisper-server\requirements-asr-parakeet.txt
```

`requirements-asr-parakeet.txt` installs `transformers>=5.20,<6`, which supports
both Parakeet and Granite. If you only need Granite, use
`requirements-asr-granite.txt` (`transformers>=5.16,<6`) instead.

The Parakeet file also installs `librosa`, which the Parakeet processor imports,
and both files install `torchaudio`, which Granite's feature extractor needs.
The registry reports a model unavailable if either package is missing.

### Qwen3-ASR (separate environment)

`qwen-asr==0.0.6` pins `transformers==4.57.6`, which conflicts with the
Transformers 5.x runtimes. Use a separate interpreter. Python 3.11 and 3.12
both work; the environment below was verified with Python 3.11.9. The
requirements file keeps `huggingface_hub>=0.34,<1.0` because that older
Transformers release requires a pre-1.0 hub client.

```powershell
py -3.12 -m venv whisper-server\.venv-asr-qwen
.\whisper-server\.venv-asr-qwen\Scripts\python.exe -m pip install --upgrade pip
.\whisper-server\.venv-asr-qwen\Scripts\python.exe -m pip install -r whisper-server\requirements-asr-qwen.txt
$env:VOXA_ASR_PYTHON = "C:\project-v2\chatgpt project\my-voice-app\whisper-server\.venv-asr-qwen\Scripts\python.exe"
```

Voxa uses one optional service at a time. Switch `VOXA_ASR_PYTHON` to change
between the Qwen and Transformers environments, then restart Voxa or change an
optional speech setting so the service is started with the new interpreter.

### CUDA on RTX 50-series and newer

A PyTorch wheel can expose `torch.cuda.is_available()` while still lacking
kernels for the GPU's compute capability. Some `cu124` wheels have this problem
on `sm_120` cards such as the RTX 5070 Ti. Install matching `torch` and
`torchaudio` wheels from a newer index before installing a requirements file:

```powershell
# Parakeet and Granite (torchaudio is required)
.\whisper-server\.venv-asr\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cu128 torch torchaudio

# Qwen (torchaudio is not used by this backend)
.\whisper-server\.venv-asr-qwen\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cu128 torch
```

Voxa checks the GPU architecture against `torch.cuda.get_arch_list()`, not only
`torch.cuda.is_available()`. An explicit `ASR_DEVICE=cuda` fails with the
unsupported-architecture message; `Auto` selects CPU and records the reason in
the status card.

This workstation's `.venv-asr` uses `torch 2.11.0+cu128` and
`torchaudio 2.11.0+cu128`, and `sm_120` is in the architecture list. Parakeet
and Granite both ran with `device: cuda` and `compute_type: float16` (see the
verification results below).

The first CUDA inference in a process pays kernel compilation/autotuning cost
and can take several seconds after the model reports ready; later calls reuse
the compiled kernels and are much faster. Do not measure GPU latency from the
first request, and expect the first dictation after loading a model to be
slower than subsequent ones.

## CLI

The same package works without Electron:

```powershell
# List supported models, backend availability, and cache state
.\whisper-server\.venv-asr\Scripts\python.exe -m asr models

# Show resolved cache, device, and active model
.\whisper-server\.venv-asr\Scripts\python.exe -m asr status

# Transcribe a file and print JSON
.\whisper-server\.venv-asr\Scripts\python.exe -m asr transcribe --model parakeet-tdt-0.6b-v3 --file .\sample.wav --json

# Capture one utterance from the microphone
.\whisper-server\.venv-asr\Scripts\python.exe -m asr transcribe --model whisper-small --mic

# Download without loading
.\whisper-server\.venv-asr\Scripts\python.exe -m asr download --model granite-speech-5.0-470m-turboctc

# Run the localhost service directly (the app does this for you)
.\whisper-server\.venv-asr\Scripts\python.exe -m asr serve --host 127.0.0.1 --port 8756
```

Use `python -m asr --help` for the full command list and exit codes. The
`--json` result has the same structured fields as the HTTP API.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ASR_MODEL` | Default model id. |
| `ASR_BACKEND` | Backend override (`auto` is normal). |
| `ASR_DEVICE` | `auto`, `cpu`, or `cuda`. |
| `ASR_COMPUTE_TYPE` | `auto`, `float32`, `float16`, or `bfloat16`. |
| `ASR_MODEL_CACHE` | Root for downloaded and extracted model directories. |
| `ASR_LANGUAGE` | Optional language hint; blank means model default/detection. |
| `ASR_WORD_TIMESTAMPS` | `1`/`true` requests native word timestamps where supported. |
| `ASR_VAD` | `0`/`false` disables trimming where the backend supports it. |
| `ASR_CHUNK_SECONDS` | Chunk length for non-long-form backends (default 30, max 120). |
| `ASR_LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING`, or `ERROR`. |
| `ASR_OFFLINE` | `1`/`true` forbids downloads; a missing model becomes an error. |
| `ASR_CPU_FALLBACK` | `0`/`false` prevents automatic CPU retry after CUDA OOM. |
| `ASR_QWEN_ALIGNER` | `1`/`true` enables the separate Qwen forced aligner. |
| `ASR_QWEN_ALIGNER_PATH` | Explicit path to Qwen3-ForcedAligner-0.6B. |
| `VOXA_ASR_PYTHON` | Interpreter used by the Electron app for the service. |
| `VOXA_ASR_ROOT` | Folder containing the `asr` package when it is not beside the app. |
| `VOXA_WHISPER_CACHE` | Existing Whisper cache root used for compatibility. |
| `HF_TOKEN` | Optional Hugging Face token for gated/private downloads. |

## Cache and offline use

- Optional models: `%APPDATA%\my-voice-app\asr-models`.
- Existing Whisper models are reused through
  `%APPDATA%\my-voice-app\whisper-models`.
- The service never downloads at startup. Downloads begin only from an explicit
  download/load action.
- After the model files and Python dependencies are present, inference is
  local. Set `ASR_OFFLINE=1` to turn a missing file into an immediate error
  instead of a download attempt.
- Qwen word timestamps are disabled unless the separate
  `Qwen3-ForcedAligner-0.6B` weights are already in
  `%APPDATA%\my-voice-app\asr-models\models\Qwen3-ForcedAligner-0.6B` (or
  `ASR_QWEN_ALIGNER_PATH` is set). They are not downloaded automatically.
- To enable Qwen timestamps, download the aligner once (about 1.7 GB) with the
  Qwen environment's `hf` command, then set `ASR_QWEN_ALIGNER=1` and reload the
  model:

  ```powershell
  .\whisper-server\.venv-asr-qwen\Scripts\hf.exe download Qwen/Qwen3-ForcedAligner-0.6B --local-dir "$env:APPDATA\my-voice-app\asr-models\models\Qwen3-ForcedAligner-0.6B"
  ```

- Parakeet's native **token** timestamps are returned only when timestamp
  output is requested (`ASR_WORD_TIMESTAMPS=1` or the Word timestamps setting).
  Otherwise `tokens` is `null`. They are never relabeled as words.

## HTTP API

The bundled Whisper server's `POST /v1/audio/transcriptions` endpoint accepts an
optional `language` multipart field (a 2–3 letter ISO code such as `en`). It is
passed to faster-whisper; an empty or absent field keeps automatic detection.
Out-of-range or malformed hints are rejected with HTTP 400.

The optional service binds to `127.0.0.1` and, when the app starts it, requires a
random bearer token (`ASR_SERVICE_TOKEN`) that never reaches the renderer. Endpoints:

- `GET /health`
- `GET /status`
- `GET /models`
- `POST /models/load`
- `POST /models/cancel`
- `POST /models/unload`
- `POST /models/download`
- `POST /transcribe` (multipart audio, no arbitrary file paths)
- `POST /transcribe/cancel`

`POST /transcribe` never loads or downloads a model implicitly; call
`POST /models/load` first. HTTP transcription also uses the language field from
that request rather than the language captured when the service started, so
clearing the app's language setting takes effect without reloading the model.
The CLI keeps its explicit auto-load behavior.

The Electron bridge exposes only the typed ASR channels in `preload.cjs`; the
renderer cannot execute shell commands, choose an interpreter, or access the
token.

## Packaging

Electron-builder includes the `asr` Python package and unpacks it outside
`app.asar`. It does **not** bundle a Python runtime, virtual environment, or
model weights. In a packaged build Voxa looks for a runtime in
`resources\asr-runtime`, then `%APPDATA%\my-voice-app\asr-runtime`, and otherwise
uses `VOXA_ASR_PYTHON` or `python` from `PATH`. Whisper-only users need none of
that.

## Tests and verification status

```powershell
npm run test:asr          # JS normalization + Python unit tests (mocks)
npm run test:asr:integration
```

The integration command starts the real service and lists the registry. Add
`--transcribe <file> --model whisper-tiny` to load and transcribe with a real
cached model; use `VOXA_ASR_PYTHON` to choose the environment.

Verified on this workstation on 2026-10-26 and early 2026-10-27:

- `npm run test:asr` passes 19/19: 18 JavaScript normalization and lifecycle
  checks plus 81 Python unit tests with mocks. `npm run verify` passes with only
  the existing IPC/renderer/overlay warnings. `npm run selftest` passes 53/53
  with Ollama reachable. Opt-in integration runs pass 20/20 against Parakeet,
  Granite, and Qwen, with both CPU and CUDA service paths.
- The real localhost service starts, authenticates, lists the registry, loads a
  cached model, and transcribes the generated `voxa-asr-sample.wav` on CPU.
- **Whisper tiny** (`whisper-server\.venv`, faster-whisper, CPU): text
  `"Volkze ASR service test 1-2-3"`, language `en`, no warnings.
- **Parakeet TDT 0.6B v3** (`.venv-asr`, `transformers-tdt`, CPU float32):
  text `"VOXA ASR Service Test, 123"`, 16 native **token** timestamps when
  timestamps are requested, `language: null`, `words: null`, load 5.6 s,
  inference 0.359 s, real-time factor 0.086. The same result was reproduced
  through the real HTTP service in `npm run test:asr:integration`.
- **Parakeet TDT 0.6B v3** (same environment, CUDA float16, RTX 5070 Ti):
  identical text and 16 token timestamps, `language: null`, load 6.6 s. The
  first inference took 1.8-16.7 s depending on process/cache state; later
  calls took 0.06-0.11 s (0.19 s with token timestamps). Peak CUDA allocation
  was 1.21 GB, with no warnings. The CUDA path also passed the real HTTP
  integration run (20/20).
- **Granite Speech 5.0 470M TurboCTC** (`.venv-asr`,
  `granite-transformers`, CPU float32): text `"Voxa asr Service Test 123."`,
  `language: null`, `segments: null`, `words: null`, `tokens: null`, load
  4.5 s, inference 0.188 s, real-time factor 0.045. Requesting word timestamps
  adds an explicit "CTC model ... does not provide timestamps" warning. The
  same result was reproduced through the real HTTP service.
- **Granite Speech 5.0 470M TurboCTC** (same environment, CUDA float16,
  RTX 5070 Ti): same text and null timestamps/language, load 6.4 s, first
  inference 11.5 s, later calls 0.047 s, peak CUDA allocation 0.90 GB, no
  warnings. The CUDA path also passed the real HTTP integration run (20/20).
- **CUDA runtime** (`.venv-asr`): `torch 2.11.0+cu128` and
  `torchaudio 2.11.0+cu128`; `torch.cuda.is_available()` is true and
  `sm_120` is in `torch.cuda.get_arch_list()`. The workstation has an RTX
  5070 Ti with 16 GB and a driver reporting CUDA UMD 13.5. The earlier
  `cu124` wheel has been replaced, so the unsupported-architecture failure is
  not the current state.
- **Qwen3-ASR 1.7B** (`.venv-asr-qwen`, `qwen-asr`, fully cached
  weights): on CPU float32, text `"Volkswagen service test one two three."`,
  native language `English`, `words: null`, `tokens: null`, load 12.1 s,
  inference 2.672 s, real-time factor 0.6425, no warnings. The same result was
  reproduced through the real HTTP service in
  `npm run test:asr:integration -- --model qwen3-asr-1.7b --transcribe <file>
  --device cpu`. On CUDA float16 (RTX 5070 Ti) the text, language, and empty
  timestamps were identical; load was 12.3 s, first inference 6.3 s, later
  calls 0.95 s, peak allocation 4.38 GB, no warnings. This environment uses
  `torch 2.11.0+cu128` (torchaudio is not needed). The CUDA HTTP path also
  passed the integration run with `--device cuda` (20/20 checks). The optional
  `Qwen3-ForcedAligner-0.6B` weights were downloaded locally and verified with
  `ASR_QWEN_ALIGNER=1`: six word timestamps were returned, from `Volkswagen`
  0.08-0.80 to `three` 2.96-3.44, with `confidence: null` and no warnings. On
  CUDA the first aligner-backed inference took 15.8 s, later calls 3.25 s,
  load 40.9 s (including the aligner), and peak allocation 5.57 GB. On CPU
  load was 19.9 s and inference 5.34 s with the same six words. The real HTTP
  service returned the same six words on CUDA. The aligner is still optional,
  is never downloaded automatically, and is enabled only when
  `ASR_QWEN_ALIGNER=1` and its weights are already present.

Dashboard checks were driven through the real Electron window over the Chrome
DevTools Protocol with an isolated `VOXA_USER_DATA` profile. The profile used
directory junctions to the existing Whisper and ASR caches, so the tests did
not copy or delete model weights:

- **Parakeet and Granite**: 13/13 checks. The initial page showed Whisper with
  the optional card hidden. Saving each engine showed its card and left the
  service stopped. Check status reported `available=true`, `downloaded=true`,
  and `idle`. CUDA float16 loads reached `Ready` in 6.8 s (Parakeet) and 5.9 s
  (Granite), and the card reported `cuda · float16`. Unload returned to
  `Idle`/`Not loaded`. A live Cancel on Parakeet appeared after 0.5 s and
  settled on `Canceled` with a working `Retry load`. Switching back to Whisper
  hid the optional card and returned to bundled Whisper; the harness's explicit
  load action completed in 1.6 s, and the switch-back path now preloads Whisper
  automatically after the optional process exits. The dashboard reported zero
  renderer exceptions or error logs.
- **Qwen3-ASR**: 9/9 checks with `.venv-asr-qwen`. Check status, CUDA float16
  load in 12.6 s, `cuda · float16` in the card, Unload, live Cancel after
  0.5 s, and the Whisper switch/restart in 1.6 s. No renderer errors.
- **Download and cancel**: 8/8 checks with a separate, empty ASR cache. The
  Download button was available and the card entered a real `downloading`
  state with a real manifest total of 2,509,473,204 bytes; progress increased
  across samples (for example 1,442 to 6,292,898 bytes). Cancel produced
  `Canceled` in both the service and the progress snapshot, hid the progress
  and Cancel controls, and re-enabled Download. The transfer was canceled
  after a few megabytes, so no large download completed.
- **Startup race fixed**: a Load arriving while Check status was still starting
  the service used to see the child process before `/health` answered and fail
  with "The ASR service is running but did not answer its health check."
  `ensureStarted()` now joins the in-flight `state.starting` promise. The
  integration suite exercises this by racing `models()` and `status()` on the
  first real start.
- **Standalone download state fixed**: `request_download()` now marks the
  manager as `downloading`, `_on_download()` distinguishes a load-owned
  download from a standalone download, and the download worker finalizes to
  `idle`, `canceled`, or `error` without overwriting a concurrent load. The
  model store also publishes terminal `canceled`/`error` progress snapshots.
  The dashboard therefore shows `Downloading` with a percentage instead of a
  misleading `Loading` state.

`npm run dist:dir` and `npm run dist` succeed. The packaged
`resources\app.asar.unpacked\asr` contains the Python sources and backends but
no virtual environments, tests, or weights. A service started against that
latest packaged layout with `isPackaged: true` loaded Parakeet, Granite, and
Qwen separately from the cache on CUDA and returned the same sample text. The
rebuilt NSIS installer is `dist\Voxa-Setup-1.3.4.exe` (264,761,090 bytes,
2026-10-27 00:46 local, SHA-256
`1AD96A0246D624218A5E390A8D739BEABBE35A119956B6DAEBDEFDC20AC3F6CD`).

### Installed-app dictation checks with a synthetic microphone

The physical speaker-to-microphone path on this workstation was too weak for a
reliable end-to-end check: playing the test phrase through the default speakers
produced about -42 dB RMS at the ZEB microphone, and Whisper returned no text.
A 1 kHz calibration tone was detectable, so the microphone itself is working;
the acoustic path is simply very quiet. To verify the rest of the installed-app
path without moving hardware, the app was launched with Chromium's fake audio
input:

```powershell
& "$env:LOCALAPPDATA\Programs\Voxa\Voxa.exe" `
  --use-fake-device-for-media-stream `
  --use-fake-ui-for-media-stream `
  --use-file-for-fake-audio-capture="$env:TEMP\opencode\voxa-manual\phrase-48k.wav"
```

This uses the real preload, IPC, recorder, main-process turn handling, Whisper
or Qwen service, typing, and history code. It does not replace the
physical-microphone check.

- **Dictation hotkey** (`Ctrl+Q`, held 10.5 s): the overlay entered `listening`,
  the transcript was
  `"Voxer manual check. Alpha Bravo Charlie. The quick brown fox jumps over the
  lazy dog. Voxer manual."`, the text was pasted into Notepad and saved, and
  history gained `"Dictated into the focused app."` with that transcript.
- **Agent hotkey** (`Ctrl+Space`, held 5.5 s): the overlay moved through
  `listening` -> `thinking` -> `answer`, the spoken question was
  `"What is 2 plus 2? Answer with just the number"`, the answer was `4`, and
  history stored the new agent turn. No approval or tool action was triggered.
- **Qwen3-ASR**: with `VOXA_ASR_PYTHON` pointing at `.venv-asr-qwen`, the model
  loaded on `cuda · float16`, dictated the spoken question into Notepad, and
  added a history entry. Switching `asrEngine` back to `whisper` stopped the
  optional service, released port 8756, and preloaded bundled Whisper; port
  8000 was `ready` with `large-v3-turbo` on CPU int8 without an explicit load.
- **Restored state**: the installed app was relaunched normally (no fake audio
  or remote-debugging flags) with the ZEB microphone selected,
  `asrEngine: whisper`, and the system playback volume restored to 34%.
  Whisper was ready on `127.0.0.1:8000`.

The physical-microphone check was completed by the owner on 2026-10-27: holding
`Ctrl+Q`, speaking into the ZEB microphone, and releasing produced
`"Obrigado."`, which was typed into the focused Notepad window and saved as a
history entry (`"Dictated into the focused app."`). That also confirms the
physical global hotkey press/release path. The agent hotkey was verified with
synthetic key input. The dashboard engine selection, Check status, Download,
Load, Cancel, Unload, and Whisper switch paths were exercised automatically.


The rebuilt NSIS installer was installed silently with `/S` on 2026-10-27 and
completed with exit code 0. `%LOCALAPPDATA%\Programs\Voxa\Voxa.exe` is version
1.3.4 from that build, and the installed app launched with the dashboard
window visible, the notch overlay active, and bundled Whisper listening on
`127.0.0.1:8000` (large-v3-turbo, CPU int8).

After the Whisper switch-back change, the installer was rebuilt again and
reinstalled with `/S` (exit code 0). The packaged `main.cjs` in `app.asar`
matched the source. An installed-app Qwen test driven through the real preload
and IPC path found the model available and downloaded, loaded
`qwen3-asr-1.7b` on `cuda · float16`, unloaded back to `idle`, restored
`asrEngine: whisper`, and then observed bundled Whisper become ready again
(`large-v3-turbo`, CPU int8) without an explicit load action. The test closed
the app after it passed. The final installed-app run used a normal relaunch (no
`VOXA_ASR_PYTHON`, no fake-audio or remote-debugging flags); the notch was
visible and bundled Whisper was ready on `127.0.0.1:8000`
(`large-v3-turbo`, CPU int8). This is the state left for the owner.

The packaged app does not bundle
an optional ASR runtime: Parakeet/Granite work when Voxa is launched with
`VOXA_ASR_PYTHON` pointing at `whisper-server\.venv-asr\Scripts\python.exe`,
and Qwen needs the separate `.venv-asr-qwen` interpreter. Bundled Whisper needs
neither.

