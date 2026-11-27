import type { EventEmitter } from "node:events";
import type { Segment, Speaker } from "../core/types";

export type TranscriberEvents = {
  /** A finished sentence, or the piece before a pause: send it to the classifier. */
  segment: [Segment];
  /** Better final text for a segment already sent. */
  revise: [{ id: string; text: string; end: number }];
  /** Words heard but not yet in a segment, for the transcript pane. */
  live: [{ speaker: Speaker; text: string }];
  error: [Error];
  close: [{ code: number; reason: string }];
};

/** Audio in, segments out. Deepgram is the first implementation; others can be swapped in. */
export interface Transcriber extends EventEmitter<TranscriberEvents> {
  readonly name: string;
  start(): Promise<void>;
  /** 16 kHz, 16-bit little-endian PCM, channels interleaved (channel 0 = you, 1 = them). */
  write(pcm: Buffer): void;
  stop(): Promise<void>;
}
