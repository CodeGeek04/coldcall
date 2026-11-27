// Audio thread. Input: two channels (0 = you, 1 = them). Output to the page every 100 ms:
// 16-bit PCM with the channels interleaved, plus the peak level of each channel.
class PcmEncoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = Math.round(sampleRate / 10);
    this.buf = new Int16Array(this.frames * 2);
    this.n = 0;
    this.peak = [0, 0];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const a = input[0];
    const b = input[1] || null;
    for (let i = 0; i < a.length; i++) {
      const l = clamp(a[i]);
      const r = b ? clamp(b[i]) : 0;
      this.buf[this.n * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
      this.buf[this.n * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
      if (Math.abs(l) > this.peak[0]) this.peak[0] = Math.abs(l);
      if (Math.abs(r) > this.peak[1]) this.peak[1] = Math.abs(r);
      if (++this.n === this.frames) {
        const pcm = this.buf.slice().buffer;
        this.port.postMessage({ pcm, levels: this.peak }, [pcm]);
        this.n = 0;
        this.peak = [0, 0];
      }
    }
    return true;
  }
}

function clamp(x) {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

registerProcessor("pcm-encoder", PcmEncoder);
