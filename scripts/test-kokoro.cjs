const fs = require('node:fs');
const path = require('node:path');
const { synthesize } = require('../lib/kokoro-tts.cjs');

(async () => {
  try {
    console.log('Synthesizing...');
    const buf = await synthesize('Testing Kokoro inside Voxa.');
    const out = path.join(__dirname, '..', 'test-kokoro.wav');
    fs.writeFileSync(out, buf);
    console.log('Wrote', out, buf.length, 'bytes');
  } catch (e) {
    console.error('FAILED:', e);
    process.exit(1);
  }
})();
