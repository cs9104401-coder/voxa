'use strict';

class TtsPlayer {
  constructor() {
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.queue = [];
    this.playing = false;
    this.currentSource = null;
  }

  async play(buffer) {
    if (!buffer || buffer.length === 0) return;

    // Buffer is a Uint8Array from IPC. Need to copy to ArrayBuffer.
    const audioData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const audioBuffer = await this.context.decodeAudioData(audioData);
    this.queue.push(audioBuffer);

    if (!this.playing) {
      this.playNext();
    }
  }

  async playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      return;
    }

    this.playing = true;
    const audioBuffer = this.queue.shift();
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);

    this.currentSource = source;

    source.onended = () => {
      if (this.currentSource === source) {
        this.currentSource = null;
      }
      this.playNext();
    };

    source.start(0);
  }

  stop() {
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
  }
}

window.ttsPlayer = new TtsPlayer();
