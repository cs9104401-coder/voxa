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
    this.playing = false;
    this.currentSource = null;
  }

  async play(buffer) {
    if (!buffer || buffer.length === 0) return;
    const gen = this.gen || 0;

    // Buffer is a Uint8Array from IPC. Need to copy to ArrayBuffer.
    const audioData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    if (this.context.state === 'suspended') await this.context.resume().catch(() => {});
    const audioBuffer = await this.context.decodeAudioData(audioData);
    if (gen !== (this.gen || 0)) return;
    this.queue.push(audioBuffer);

    if (!this.playing) {
      this.playNext();
    }
  }

  async playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      this.stopSpeechFeed();
      return;
    }

    this.playing = true;
    const audioBuffer = this.queue.shift();
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);

    this.currentSource = source;

    source.onended = () => {
      // stop() or a newer source already moved playback on: this end event is
      // stale and must not pop the next queued buffer or stop the speech feed.
      if (this.currentSource !== source) return;
      this.currentSource = null;
      this.playNext();
    };

    this.startSpeechFeed();
    try {
      source.start(0);
    } catch {
      if (this.currentSource === source) this.currentSource = null;
      this.playing = false;
      this.queue = [];
      this.stopSpeechFeed();
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
    if (this.currentSource) {
      try {
        this.currentSource.stop(0);
      } catch {
        // May already have stopped
      }
      this.currentSource = null;
    }
    this.playing = false;
    this.stopSpeechFeed();
  }
}

window.ttsPlayer = new TtsPlayer();
