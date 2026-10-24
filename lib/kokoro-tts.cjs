'use strict';
let ttsPromise = null;

async function loadModel() {
  const mod = await import('kokoro-js');
  const KokoroTTS = mod.KokoroTTS || (mod.default && mod.default.KokoroTTS);
  if (!KokoroTTS) throw new Error('kokoro-js exports: ' + Object.keys(mod).join(', '));
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
}

function warmup() {
  if (!ttsPromise) ttsPromise = loadModel().catch((e) => { ttsPromise = null; throw e; });
  return ttsPromise;
}

async function synthesize(text, voice = 'af_heart') {
  const tts = await warmup();
  const audio = await tts.generate(text, { voice });
  return Buffer.from(audio.toWav());
}

module.exports = { synthesize, warmup };
