'use strict';

class TtsPlayer {
  constructor() {
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.queue = [];
    this.playing = false;
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

    source.onended = () => {
      this.playNext();
    };

    source.start(0);
  }
}

window.ttsPlayer = new TtsPlayer();
