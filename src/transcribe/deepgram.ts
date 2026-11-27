import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Speaker } from "../core/types";
import { SentenceSegmenter, type SegmenterOptions, type StreamResult } from "./segmenter";
import type { Transcriber, TranscriberEvents } from "./transcriber";

export interface DeepgramOptions {
  apiKey: string;
  /** Speaker per channel: ["you", "them"] for two-channel capture. */
  speakers: Speaker[];
  sampleRate?: number;
  model?: string;
  /** Silence that ends an utterance (speech_final). */
  endpointingMs?: number;
  /** Word gap that triggers UtteranceEnd, a fallback for noisy audio. */
  utteranceEndMs?: number;
  segmenter?: SegmenterOptions;
}

interface DeepgramResults {
  type: "Results";
  channel_index: [number, number];
  is_final: boolean;
  speech_final: boolean;
  channel: { alternatives: { transcript: string; words: { word: string; punctuated_word?: string; start: number; end: number }[] }[] };
}

/**
 * Deepgram live streaming (v1 listen). One socket carries both channels (multichannel), with
 * interim results so every word arrives as it is spoken. The segmenter turns words into sentences.
 */
export class DeepgramTranscriber extends EventEmitter<TranscriberEvents> implements Transcriber {
  readonly name: string;
  private ws: WebSocket | null = null;
  private readonly segmenter: SentenceSegmenter;
  private queue: Buffer[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private lastSend = 0;

  constructor(private readonly opts: DeepgramOptions) {
    super();
    this.name = `deepgram:${opts.model ?? "nova-3"}`;
    this.segmenter = new SentenceSegmenter(opts.speakers, opts.segmenter);
    this.segmenter.on("segment", (s) => this.emit("segment", s));
    this.segmenter.on("revise", (r) => this.emit("revise", r));
    this.segmenter.on("live", (l) => this.emit("live", l));
  }

  url(): string {
    const o = this.opts;
    const params = new URLSearchParams({
      model: o.model ?? "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: String(o.sampleRate ?? 16000),
      channels: String(o.speakers.length),
      multichannel: String(o.speakers.length > 1),
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: String(o.endpointingMs ?? 300),
      utterance_end_ms: String(o.utteranceEndMs ?? 1000),
      vad_events: "true",
    });
    return `wss://api.deepgram.com/v1/listen?${params}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(), { headers: { Authorization: `Token ${this.opts.apiKey}` } });
      this.ws = ws;
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => reject(new Error(`Deepgram refused the connection: HTTP ${res.statusCode} ${body.slice(0, 300)}`)));
      });
      ws.on("open", () => {
        for (const chunk of this.queue) ws.send(chunk);
        this.queue = [];
        this.lastSend = Date.now();
        // Deepgram closes a silent socket after about 10 s.
        this.keepAlive = setInterval(() => {
          if (Date.now() - this.lastSend > 4000 && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
        }, 2000);
        resolve();
      });
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
      ws.on("close", (code, reason) => {
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.segmenter.flushAll();
        this.emit("close", { code, reason: reason.toString() });
      });
    });
  }

  /** 16-bit little-endian PCM, channels interleaved in `speakers` order. Queued until the socket opens. */
  write(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
      this.lastSend = Date.now();
    } else {
      this.queue.push(pcm);
    }
  }

  /** Asks Deepgram to finish the audio it has, waits for the last results, then closes. */
  stop(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const done = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 5000);
      ws.once("close", () => {
        clearTimeout(done);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      else ws.terminate();
    });
  }

  private onMessage(raw: string): void {
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "Results") {
      const r = msg as DeepgramResults;
      const alt = r.channel.alternatives[0];
      const result: StreamResult = {
        channel: r.channel_index[0],
        words: (alt?.words ?? []).map((w) => ({ word: w.punctuated_word ?? w.word, start: w.start, end: w.end })),
        isFinal: r.is_final,
        speechFinal: r.speech_final,
      };
      this.segmenter.onResult(result);
    } else if (msg.type === "UtteranceEnd") {
      const ch = (msg as { channel?: [number, number] }).channel?.[0] ?? 0;
      this.segmenter.onUtteranceEnd(ch);
    }
  }
}
