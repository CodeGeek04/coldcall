import type { RealtimeClock, SteppedClock } from "../core/clock";
import type { Pipeline } from "../core/pipeline";
import type { Transcript } from "../core/types";

/**
 * Feeds each segment at the moment it became final (its `end`), at clock speed.
 * Requests overlap exactly as they would live; results may arrive out of order.
 */
export async function replayRealtime(t: Transcript, pipeline: Pipeline, clock: RealtimeClock, signal?: AbortSignal): Promise<void> {
  for (const seg of t.segments) {
    const waitMs = (seg.end * 1000 - clock.now()) / clock.speed;
    if (waitMs > 0) await sleep(waitMs, signal);
    if (signal?.aborted) return;
    pipeline.tick();
    void pipeline.pushFinal(seg);
  }
  await pipeline.drain();
}

/** As fast as the classifier allows: one segment at a time, each result applied before the next. */
export async function replayFast(t: Transcript, pipeline: Pipeline, clock: SteppedClock, signal?: AbortSignal): Promise<void> {
  for (const seg of t.segments) {
    if (signal?.aborted) return;
    clock.set(seg.end * 1000);
    pipeline.tick();
    await pipeline.pushFinal(seg);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
