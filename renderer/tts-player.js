'use strict';

class TtsPlayer {
  constructor() {
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    // Phase C: one analyser tap between every played source and the speakers so
    // speech levels are measured from the real TTS audio graph. Cosmetic-only:
    // metering failures must never break playback.
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.context.destination);
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
    this.speechTimer = null;
    this.queue = [];
    this.sources = new Set();
    this.playing = false;
    this.currentSource = null;
    this.nextStartTime = 0;
    // decodeAudioData resolves in completion order, not call order. Chaining
    // decodes keeps sentence audio in the order the sidecar produced it.
    this.decodeChain = Promise.resolve();
  }

  play(buffer) {
    if (!buffer || buffer.length === 0) return Promise.resolve();
    const gen = this.gen || 0;
    const audioData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const job = this.decodeChain.then(async () => {
      if (gen !== (this.gen || 0)) return;
      if (this.context.state === 'suspended') await this.context.resume().catch(() => {});
      const audioBuffer = await this.context.decodeAudioData(audioData);
      if (gen !== (this.gen || 0)) return;
      this.queue.push(audioBuffer);
      if (!this.playing) {
        this.playing = true;
        this.nextStartTime = this.context.currentTime + 0.04;
        this.startSpeechFeed();
      }
      this.schedule();
    }).catch(() => {
      // A malformed WAV must not poison the rest of the queue.
    });
    this.decodeChain = job;
    return job;
  }

  schedule() {
    while (this.queue.length) {
      const audioBuffer = this.queue.shift();
      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.analyser);

      const startAt = Math.max(this.context.currentTime + 0.02, this.nextStartTime || 0);
      this.nextStartTime = startAt + audioBuffer.duration;
      this.currentSource = source;
      this.sources.add(source);

      source.onended = () => {
        this.sources.delete(source);
        if (this.currentSource === source) this.currentSource = null;
        if (this.sources.size === 0 && this.queue.length === 0) {
          this.playing = false;
          this.nextStartTime = 0;
          this.stopSpeechFeed();
        }
      };

      try {
        source.start(startAt);
      } catch {
        this.sources.delete(source);
        if (this.currentSource === source) this.currentSource = null;
        this.playing = false;
        this.queue = [];
        this.stopSpeechFeed();
      }
    }
  }

  startSpeechFeed() {
    if (this.speechTimer) return;
    this.speechTimer = setInterval(() => {
      if (!this.playing) {
        this.stopSpeechFeed();
        return;
      }
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(this.analyserData);
      let sum = 0;
      for (const value of this.analyserData) sum += value;
      const level = Math.min(1, sum / (this.analyserData.length * 160));
      this.sendSpeechLevel(level);
    }, 100);
  }

  stopSpeechFeed() {
    if (this.speechTimer) {
      clearInterval(this.speechTimer);
      this.speechTimer = null;
      this.sendSpeechLevel(0);
    }
  }

  sendSpeechLevel(level) {
    try {
      window.voiceAgent?.recorder?.speechLevel?.({ level: Math.max(0, Math.min(1, level || 0)), at: Date.now() });
    } catch {
      // Metering is cosmetic; never let it break playback.
    }
  }

  stop() {
    this.gen = (this.gen || 0) + 1;
    this.queue = [];
    for (const source of this.sources) {
      try {
        source.stop(0);
      } catch {
        // May already have stopped.
      }
    }
    this.sources.clear();
    this.currentSource = null;
    this.playing = false;
    this.nextStartTime = 0;
    this.stopSpeechFeed();
  }
}

window.ttsPlayer = new TtsPlayer();
