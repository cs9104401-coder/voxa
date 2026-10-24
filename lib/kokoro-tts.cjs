'use strict';
const path = require('node:path');
let ttsPromise = null;

function cacheDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'kokoro-cache');
  } catch (e) { /* plain node (test script) */ }
  return null;
}

async function loadModel() {
  const dir = cacheDir();
  if (dir) {
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = dir;
  }
  const mod = await import('kokoro-js');
  const KokoroTTS = mod.KokoroTTS || (mod.default && mod.default.KokoroTTS);
  if (!KokoroTTS) throw new Error('kokoro-js exports: ' + Object.keys(mod).join(', '));
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
}

function warmup() {
  if (!ttsPromise) ttsPromise = loadModel().catch((e) => { ttsPromise = null; throw e; });
  return ttsPromise;
}

async function synthesize(text, voice = 'af_heart', speed = 1.0) {
  const tts = await warmup();
  const audio = await tts.generate(text, { voice, speed });
  return Buffer.from(audio.toWav());
}

module.exports = { synthesize, warmup };
