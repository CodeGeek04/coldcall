export type Speaker = "you" | "them";

/** Ground truth for one segment, from hand labels or a number-key override. */
export interface SegmentLabel {
  block?: string;
  stance?: string;
}

/** One final segment from the transcriber (or a transcript file). */
export interface Segment {
  id: string;
  speaker: Speaker;
  text: string;
  /** Seconds from call start. */
  start: number;
  /** Seconds from call start; the moment the transcriber marked it final. */
  end: number;
  label?: SegmentLabel;
}

export interface Transcript {
  id: string;
  description?: string;
  segments: Segment[];
}

/** Option id to probability. */
export type Probs = Record<string, number>;

export interface ClassifyRequest {
  seq: number;
  /** The last N final segments, oldest first. */
  window: Segment[];
  /** Block on screen when the request was sent, or null before the first one. */
  currentBlock: string | null;
}

export interface ClassifyResult {
  seq: number;
  block: Probs;
  stance: Probs;
  /** 0 to 1. */
  readiness: number;
  /** Probability that each move's trigger is true, by move key (see movesFrom). */
  moves?: Probs;
  /** For example "jev:jev-1.14.0" or "mock". */
  classifier: string;
  /** Wall-clock time the classifier took. */
  latencyMs: number;
  inputTokens?: number;
  raw?: unknown;
}

export interface Classifier {
  readonly name: string;
  classify(req: ClassifyRequest, signal?: AbortSignal): Promise<ClassifyResult>;
}

export interface ProbEntry {
  id: string;
  p: number;
}

/** What the screen shows. Produced only by the state machine. */
export interface DisplayState {
  /** Seq of the last result applied (0 before any). */
  seq: number;
  /** Call time in ms when this state was computed. */
  atMs: number;
  /** Lit block: the last confident block. Null before the first one. */
  block: string | null;
  /** Top block is under the unknown threshold: map dims, direction reads unknown. */
  unknown: boolean;
  /** Set while a manual override holds the block. */
  pinned: { block: string; untilMs: number } | null;
  /** Top two blocks of the latest result when they are close, else null. */
  tie: [ProbEntry, ProbEntry] | null;
  /** Top block of the latest raw result. */
  top: ProbEntry | null;
  stance: string | null;
  /** Smoothed probability of the shown stance. */
  stanceConfidence: number;
  /** Smoothed readiness, 0 to 1. */
  readiness: number | null;
  /** What to do next, once a move's trigger fires: the block to go to and why. */
  next: { block: string; because: string; p: number } | null;
  /** The next move's direction if there is one, else the current block's. */
  direction: string;
  /** True when this update changed the lit block. */
  switched: boolean;
}
