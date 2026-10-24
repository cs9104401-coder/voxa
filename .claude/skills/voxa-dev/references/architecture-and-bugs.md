# Voxa architecture and known bug patterns

## Files (responsibilities inferred from names; read a file before relying on this)
- main.cjs: app lifecycle, single-instance lock, windows, tray, IPC wiring. preload.cjs: the only bridge to the renderer (window.voiceAgent.*). brand.cjs: app name.
- lib/: agent-loop (LLM turns, streaming, tool calls), approval (risk tiers, notch prompts), apps (Start Menu discovery), constants (defaults, timings, settingsVersion), desktop (focus capture, paste/type), hotkeys (uiohook-napi, hold-to-talk), logger (JSONL, redaction), overlay (notch/island window), permissions (media permission), recorder (hidden recorder window), services (Ollama, Whisper server, providers, health), store (settings.json, safeStorage, migrations), tool-schema (strict schemas), selftest-runtime.
- renderer/: dashboard.js + settings.html (pages), overlay.html/js (notch), recorder.html/js (mic, VAD, level), style.css (tokens, components).
- whisper-server/server.py: FastAPI faster-whisper, built to whisper-server\dist\voxa-whisper.exe by scripts/build-whisper.cjs. Settings and logs: %APPDATA%\my-voice-app\.

## Packaging
electron-builder NSIS, build.npmRebuild is false (no Visual Studio needed), uiohook-napi must stay in asarUnpack, installer is unsigned (SmartScreen warning is expected), per-user install. Settings live in AppData so upgrades keep them.

## Windows traps
Elevated (admin) windows cannot receive pasted or typed input. Store apps (Notepad) can report ApplicationFrameHost as the foreground window. Test DPI 100/125/150/200% and multi-monitor. Ctrl+Shift is the language-switch shortcut. A lone Alt tap can focus the menu bar. Antivirus may flag keyboard hooks.

## Bugs this project has already had (do not reintroduce)
1. A top-level renderer identifier named `history` shadowed window.history and crashed navigation.
2. IPC mismatches: a channel invoked with no handler; listeners registered twice (duplicate "model reply" lines).
3. Overlay with no animation: window bounds changed per state, window hidden and shown per state, content swapped with innerHTML. Also empty black area and clipped corners from a non-fixed window.
4. Recording heard nothing: hidden window throttled, no media permission, silent audio sent, key-up missed for modifier-only combos.
5. Dictation said "could not find the focused app": relied on the foreground handle instead of clipboard paste into whatever has focus.
6. faster-whisper float16 on CPU crashed; a large model download blocked startup; CUDA libraries missing.
7. Custom provider URL rejected because only https was allowed, blocking localhost routers.
8. Fallback provider defaulted to openai with the toggle on.
9. Agent tools that ran npm start or servers hung the session.