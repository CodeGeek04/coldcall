import { z } from "zod";
import type { Summary } from "../core/summary";
import type { DisplayState, ProbEntry, Segment, Speaker } from "../core/types";

/** What the screen needs from playbook.yaml. Blocks keep playbook order; `key` is the override key. */
export interface PlaybookView {
  blocks: { id: string; describe: string; key: number | null }[];
  stances: { id: string; describe: string }[];
  unknownDirection: string;
}

export interface TranscriptInfo {
  file: string;
  id: string;
  description?: string;
  segments: number;
  seconds: number;
}

export interface AudioInfo {
  /** Opaque key the server resolves to a file. */
  file: string;
  /** Display name. */
  id: string;
  seconds: number;
  /** saved: a live call recorded with Save audio; sample: generated with pnpm make-audio. */
  kind: "saved" | "sample";
}

export type ClassifierKind = "jev" | "mock";

/** typed: a transcript file; recorded: an audio file through the transcriber; live: the browser's audio. */
export type RunMode = "typed" | "recorded" | "live";

export type ServerMsg =
  | {
      type: "hello";
      playbook: PlaybookView;
      transcripts: TranscriptInfo[];
      audioFiles: AudioInfo[];
      classifiers: ClassifierKind[];
      /** A transcriber key is set, so recorded and live calls work. */
      canTranscribe: boolean;
    }
  | {
      type: "run";
      status: "started";
      runId: number;
      mode: RunMode;
      name: string;
      classifier: string;
      speed: number;
      /** Length in seconds, or null for a live call. */
      seconds: number | null;
      /** For a recorded call: the audio to play while it runs. */
      audioUrl: string | null;
    }
  | { type: "run"; status: "finished" | "stopped"; runId: number; summary: Summary | null; logPath: string | null; audioPath: string | null }
  /** The recordings list changed (a live call was saved). */
  | { type: "audio-files"; audioFiles: AudioInfo[] }
  | { type: "segment"; runId: number; segment: Segment }
  | { type: "revision"; runId: number; id: string; text: string }
  /** Words heard but not yet in a sentence. */
  | { type: "words"; runId: number; speaker: Speaker; text: string }
  | { type: "state"; runId: number; state: DisplayState }
  | { type: "evaluation"; runId: number; seq: number; stale: boolean; lagMs: number; latencyMs: number; top: ProbEntry | null }
  | { type: "failure"; runId: number; seq: number; message: string }
  | { type: "error"; message: string };

const Classifier = z.enum(["jev", "mock"]);

export const ClientMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), transcript: z.string(), classifier: Classifier, speed: z.number().min(0.25).max(8) }),
  z.object({ type: z.literal("play-audio"), file: z.string(), classifier: Classifier }),
  /** Starts a live call. Audio follows as binary frames: 16 kHz 16-bit PCM, you and them interleaved. */
  z.object({ type: z.literal("listen"), classifier: Classifier, record: z.boolean() }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("override"), block: z.string() }),
]);

export type ClientMsg = z.infer<typeof ClientMsgSchema>;
