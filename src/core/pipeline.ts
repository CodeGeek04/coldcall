import { EventEmitter } from "node:events";
import type { Clock } from "./clock";
import type { Playbook } from "./playbook";
import type { SessionLog } from "./sessionLog";
import { DEFAULT_TUNING, StanceStateMachine, type Tuning } from "./stateMachine";
import type { ClassifyResult, Classifier, DisplayState, Segment } from "./types";

export interface PipelineOptions {
  playbook: Playbook;
  classifier: Classifier;
  clock: Clock;
  log?: SessionLog;
  /** Final segments sent per request (about the last minute). */
  windowSize?: number;
  tuning?: Tuning;
}

export interface Evaluation {
  seq: number;
  /** The final segment that triggered this request. */
  segment: Segment;
  requestedAtMs: number;
  resolvedAtMs: number;
  /** Display lag: result applied minus end of the finalized segment, in call time. */
  lagMs: number;
  currentBlock: string | null;
  window: Segment[];
  result: ClassifyResult;
  stale: boolean;
  state: DisplayState;
}

export interface ClassifyFailure {
  seq: number;
  segment: Segment;
  error: unknown;
}

type Events = {
  segment: [Segment];
  evaluation: [Evaluation];
  /** Anything that changed the screen: an applied result, an override, a pin expiring. */
  state: [DisplayState];
  failure: [ClassifyFailure];
  /** Corrected text for a segment already sent. */
  revision: [{ id: string; text: string }];
};

/**
 * final segment -> context window -> classifier (numbered, concurrent) -> state machine -> screen.
 * One request per final segment from either speaker; out-of-order results are dropped by seq.
 */
export class Pipeline extends EventEmitter<Events> {
  readonly machine: StanceStateMachine;
  private readonly windowSize: number;
  private window: Segment[] = [];
  private seq = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly abort = new AbortController();

  constructor(private readonly opts: PipelineOptions) {
    super();
    this.machine = new StanceStateMachine(opts.playbook, opts.tuning ?? DEFAULT_TUNING);
    this.windowSize = opts.windowSize ?? 8;
    opts.log?.write({
      type: "session",
      startedAt: new Date().toISOString(),
      classifier: opts.classifier.name,
      windowSize: this.windowSize,
      tuning: this.machine.tuning,
      blocks: opts.playbook.blocks.map((b) => b.id),
      stances: opts.playbook.stances.map((s) => s.id),
    });
  }

  get state(): DisplayState {
    return this.machine.state;
  }

  /** Feed one final segment. The returned promise settles when its result has been applied. */
  pushFinal(segment: Segment): Promise<void> {
    const { clock, classifier, log } = this.opts;
    this.window = [...this.window, segment].slice(-this.windowSize);
    const seq = ++this.seq;
    const window = this.window;
    const currentBlock = this.machine.state.block;
    const requestedAtMs = clock.now();

    log?.write({ type: "segment", seq, atMs: requestedAtMs, segment });
    this.emit("segment", segment);

    const job = classifier
      .classify({ seq, window, currentBlock }, this.abort.signal)
      .then((result) => this.onResult({ seq, segment, window, currentBlock, requestedAtMs, result }))
      .catch((error: unknown) => {
        if (this.abort.signal.aborted) return;
        log?.write({ type: "error", seq, atMs: clock.now(), segmentId: segment.id, message: String(error) });
        this.emit("failure", { seq, segment, error });
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
    return job;
  }

  /**
   * The transcriber corrected a segment already sent. The next request sees the new text;
   * no request is sent for the correction itself.
   */
  revise(id: string, text: string): void {
    this.window = this.window.map((s) => (s.id === id ? { ...s, text } : s));
    this.opts.log?.write({ type: "revision", atMs: this.opts.clock.now(), segmentId: id, text });
    this.emit("revision", { id, text });
  }

  /** Manual override (number key): pins the block and records it as a ground-truth label. */
  override(block: string): DisplayState {
    const atMs = this.opts.clock.now();
    const state = this.machine.pin(block, atMs);
    this.opts.log?.write({ type: "override", atMs, block, segmentId: this.window.at(-1)?.id ?? null, state });
    this.emit("state", state);
    return state;
  }

  /** Call periodically so a pin can expire between results. */
  tick(): void {
    const state = this.machine.tick(this.opts.clock.now());
    if (state) this.emit("state", state);
  }

  /** Waits for every request in flight. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  close(): void {
    this.abort.abort();
  }

  private onResult(args: {
    seq: number;
    segment: Segment;
    window: Segment[];
    currentBlock: string | null;
    requestedAtMs: number;
    result: ClassifyResult;
  }): void {
    const { log, clock } = this.opts;
    const resolvedAtMs = clock.now();
    const { stale, state } = this.machine.apply(args.result, resolvedAtMs);
    const ev: Evaluation = {
      ...args,
      resolvedAtMs,
      lagMs: resolvedAtMs - args.segment.end * 1000,
      stale,
      state,
    };
    const window = args.window.map((s) => ({ id: s.id, speaker: s.speaker, text: s.text }));

    log?.write({
      type: "evaluation",
      seq: ev.seq,
      segmentId: ev.segment.id,
      segmentEndMs: ev.segment.end * 1000,
      requestedAtMs: ev.requestedAtMs,
      resolvedAtMs,
      lagMs: ev.lagMs,
      latencyMs: ev.result.latencyMs,
      currentBlock: ev.currentBlock,
      window,
      raw: {
        classifier: ev.result.classifier,
        block: ev.result.block,
        stance: ev.result.stance,
        readiness: ev.result.readiness,
        moves: ev.result.moves,
        inputTokens: ev.result.inputTokens,
        answers: ev.result.raw,
      },
      stale,
      displayed: state,
      label: ev.segment.label ?? null,
    });
    if (!stale && state.unknown) {
      log?.unknown({ seq: ev.seq, atMs: resolvedAtMs, segmentId: ev.segment.id, dimmedBlock: state.block, top: state.top, tie: state.tie, window });
    }

    this.emit("evaluation", ev);
    if (!stale) this.emit("state", state);
  }
}
