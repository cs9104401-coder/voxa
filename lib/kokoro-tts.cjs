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
  const t0 = Date.now();
  const dir = cacheDir();
  if (dir) {
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = dir;
  }
  const mod = await import('kokoro-js');
  const KokoroTTS = mod.KokoroTTS || (mod.default && mod.default.KokoroTTS);
  if (!KokoroTTS) throw new Error('kokoro-js exports: ' + Object.keys(mod).join(', '));
  const model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const t1 = Date.now();
  await model.generate('Ready.', { voice: 'af_heart' });
  console.log('[kokoro] model load ' + (t1 - t0) + ' ms, first-run warm ' + (Date.now() - t1) + ' ms');
  return model;
}

function warmup() {
  if (!ttsPromise) ttsPromise = loadModel().catch((e) => { ttsPromise = null; throw e; });
  return ttsPromise;
}

async function synthesize(text, voice = 'af_heart', speed = 1.0) {
  const tts = await warmup();
  const t0 = Date.now();
  const audio = await tts.generate(text, { voice, speed });
  const wav = Buffer.from(audio.toWav());
  console.log('[kokoro] synth ' + (Date.now() - t0) + ' ms for ' + text.length + ' chars: ' + text.slice(0, 40));
  return wav;
}

module.exports = { synthesize, warmup };
