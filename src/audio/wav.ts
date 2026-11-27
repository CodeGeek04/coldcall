import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";

export interface Wav {
  sampleRate: number;
  channels: number;
  /** 16-bit little-endian PCM, channels interleaved. */
  pcm: Buffer;
}

/** Reads a 16-bit PCM WAV file. */
export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path} is not a WAV file`);
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error(`${path}: data before fmt`);
      if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) throw new Error(`${path}: only 16-bit PCM is supported`);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, pcm: buf.subarray(body, Math.min(buf.length, body + size)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

/** Length and format from the header only, without reading the samples. */
export function wavInfo(path: string): { sampleRate: number; channels: number; seconds: number } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    let offset = 12;
    let fmt: { channels: number; sampleRate: number } | null = null;
    while (offset + 8 <= n) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "fmt ") fmt = { channels: buf.readUInt16LE(offset + 10), sampleRate: buf.readUInt32LE(offset + 12) };
      if (id === "data" && fmt) return { ...fmt, seconds: size / (fmt.sampleRate * fmt.channels * 2) };
      offset += 8 + size + (size % 2);
    }
    throw new Error(`${path}: no data chunk in the header`);
  } finally {
    closeSync(fd);
  }
}

function header(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function encodeWav(w: Wav): Buffer {
  return Buffer.concat([header(w.pcm.length, w.sampleRate, w.channels), w.pcm]);
}

/** Appends PCM as it arrives and fixes the header sizes on close. */
export class WavWriter {
  private fd: number;
  private bytes = 0;

  constructor(
    private readonly path: string,
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, header(0, sampleRate, channels));
  }

  write(pcm: Buffer): void {
    writeSync(this.fd, pcm);
    this.bytes += pcm.length;
  }

  close(): void {
    writeSync(this.fd, header(this.bytes, this.sampleRate, this.channels), 0, 44, 0);
    closeSync(this.fd);
  }
}

/** Splits interleaved PCM into chunks of `ms` milliseconds. */
export function* chunks(w: Wav, ms: number): Generator<Buffer> {
  const step = Math.round((w.sampleRate * ms) / 1000) * w.channels * 2;
  for (let i = 0; i < w.pcm.length; i += step) yield w.pcm.subarray(i, i + step);
}
