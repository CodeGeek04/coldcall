/** Call time in ms since the call started. Replay and live use the same interface. */
export interface Clock {
  now(): number;
}

/** Wall time since construction, scaled by `speed`. Live calls and real-time replay use speed 1. */
export class RealtimeClock implements Clock {
  private readonly t0 = performance.now();
  constructor(readonly speed = 1) {}
  now(): number {
    return (performance.now() - this.t0) * this.speed;
  }
}

/**
 * For live audio: call time starts with the first audio chunk, so it lines up with the
 * transcriber's word times (which count from the first audio it received).
 */
export class LiveClock implements Clock {
  private t0: number | null = null;
  start(): void {
    this.t0 ??= performance.now();
  }
  now(): number {
    return this.t0 === null ? 0 : performance.now() - this.t0;
  }
}

/**
 * For fast replay: jumps to each segment's end, then runs in real time while the classifier
 * works, so measured lag still equals real classifier latency.
 */
export class SteppedClock implements Clock {
  private base = 0;
  private mark = performance.now();
  set(callMs: number): void {
    this.base = callMs;
    this.mark = performance.now();
  }
  now(): number {
    return this.base + (performance.now() - this.mark);
  }
}
