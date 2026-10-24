---
name: voxa-dev
description: Build features, redesign UI, and fix bugs in Voxa, the Electron voice assistant at C:\projects\my-voice-app (dictation and agent modes, notch/island overlay, dashboard, Whisper, Ollama and cloud providers, agent tools, hotkeys, settings, installer). Use this skill for ANY change to this project, including small UI tweaks, new tools or settings, provider changes, animation work, packaging and releases, even if the user does not say "Voxa".
---

# Voxa development

Voxa is a Windows Electron app. The owner tests on a real desktop and sends screenshots. You cannot see the GUI, so correctness comes from careful reading, small changes and the verify script, not from guessing.

## Workflow (in order)
1. **Orient.** Read references/architecture-and-bugs.md. Read every file you will touch plus the files that call into them. Run `git status --short`; if the tree is dirty, ask the owner to commit first, because a clean checkpoint is the only safe undo.
2. **Plan in 5 lines.** Files to change, new IPC channels/settings/tools, risks, what the owner must test. Use the matching recipe below.
3. **One feature or one bug per session.** Smallest diff that works. Do not refactor unrelated code, rename things, or add dependencies without asking (installer size and native-module risk are real here).
4. **Verify.** Run `npm run verify` and fix every FAIL. Review each WARN. Add new UI states to `npm run ui-gallery` data so they can be previewed without speaking. Re-read `git diff` for: unhandled promise rejections, listeners registered twice, timers never cleared, missing `await`, renderer code touching elements that do not exist on every page.
5. **Hand back.** Report: files changed, root cause (for bugs), a numbered manual test list (what to click or say, what should happen), and the commit command. Never say something works if you only checked it statically; say "static checks pass, needs a manual test".

## Hard rules (and why)
- Never launch the GUI or long-running processes (`npm start`, `npm run ui-gallery`, the Whisper server, `electron-builder`, `npm run build:whisper`). They hang agent sessions and clash with the single-instance lock. Ask the owner to run them. Bounded commands only: `node --check`, `npm run verify`, `git`, file reads.
- Never delete `whisper-server\dist` or run `build:whisper` unless server.py changed; a failed rebuild wipes the working exe.
- Originality: no code, assets, names, endpoints or text copied from other products.
- Security: contextIsolation on, nodeIntegration off, no remote content. API keys only in the main process via safeStorage, never in the renderer, logs, URLs or git. Custom URLs must be https, except when the parsed hostname is localhost, 127.0.0.1 or [::1]. Every state-changing agent tool goes through approval. Tool args are validated against a strict schema. Log through lib/logger (it redacts secrets).
- Privacy: speech, TTS and wake word stay local by default. Anything that sends audio or a screenshot to a cloud provider needs an explicit setting and a one-time warning. Never identify real people from faces.
- Settings changes need a default, validation on load, and a migration (bump `settingsVersion`).

## Recipes
**New agent tool:** strict schema in lib/tool-schema.cjs, handler in lib/agent-loop.cjs or its module, risk tier in lib/approval.cjs (read-only runs, changes ask), logging, entry on the Apps page, a case in lib/selftest-runtime.cjs, README.
**New setting:** default in lib/constants.cjs, validate and migrate in lib/store.cjs, control on the right dashboard page using shared components, apply live without a restart where possible, README.
**New IPC channel:** explicit method in preload.cjs (no generic passthrough), handler with input validation in main, listener with cleanup in the renderer. `npm run verify` must show both ends.
**New overlay state:** a CSS state class plus a content layer. Never recreate the pill element or resize the window. Add it to ui-gallery. Handle interruption mid-animation.
**Providers and models:** only through the provider interface in lib/services.cjs. List models from `GET {base}/models` in the main process. Cloud fallback defaults OFF with a privacy warning.
**UI redesign:** read references/ui-design.md first. Change tokens and shared components, not one-off styles.
**Release:** only when asked. `npm version minor|patch --no-git-tag-version`, owner tests the installed build, `npx electron-builder --win`, commit, push, `gh release create`.

## When the owner reports a bug
Ask for the Logs page lines or terminal error if missing. State the root cause in one sentence before fixing. Add a verify check or selftest case that would have caught it when feasible.
## Override
If the owner's prompt names exact files and says to only run node --check, follow the prompt exactly: do not stop for a dirty tree, do not run npm run verify, and do not touch other files.
