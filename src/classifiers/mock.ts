import { movesFrom, type Playbook } from "../core/playbook";
import type { ClassifyRequest, ClassifyResult, Classifier, Probs } from "../core/types";

export interface MockOptions {
  /** Seed for repeatable runs. */
  seed?: number;
  /** Chance a result puts its peak on a wrong block, to exercise the anti-flicker rules. */
  flipRate?: number;
  /** Chance a result is spread thin (top under the unknown threshold). */
  vagueRate?: number;
  /** Simulated latency range in ms. */
  latencyMs?: [number, number];
}

const READINESS_BY_STANCE: Record<string, number> = {
  hostile: 0.05,
  reluctant: 0.2,
  neutral: 0.4,
  open: 0.6,
  ready: 0.9,
};

/**
 * Offline stand-in for development. It reads the ground-truth labels in a hand-labeled
 * transcript and returns noisy probabilities around them, so the state machine and UI can be
 * built and tuned without spending API calls. It is not a real classifier: never score it.
 */
export class OracleMockClassifier implements Classifier {
  readonly name = "mock:oracle";
  private rng: () => number;
  private readonly flipRate: number;
  private readonly vagueRate: number;
  private readonly latency: [number, number];

  constructor(
    private readonly playbook: Playbook,
    opts: MockOptions = {},
  ) {
    this.rng = mulberry32(opts.seed ?? 7);
    this.flipRate = opts.flipRate ?? 0.15;
    this.vagueRate = opts.vagueRate ?? 0.08;
    this.latency = opts.latencyMs ?? [350, 900];
  }

  async classify(req: ClassifyRequest, signal?: AbortSignal): Promise<ClassifyResult> {
    const label = [...req.window].reverse().find((s) => s.label?.block || s.label?.stance)?.label;
    const blockIds = this.playbook.blocks.map((b) => b.id);
    const stanceIds = this.playbook.stances.map((s) => s.id);

    const block = this.noisy(blockIds, label?.block);
    const stance = this.noisy(stanceIds, label?.stance, 0.5);
    const readiness = Math.min(1, Math.max(0, (READINESS_BY_STANCE[label?.stance ?? ""] ?? 0.3) + (this.rng() - 0.5) * 0.15));

    // Moves: the label already moved on from the current block, so its trigger "fired".
    const moves = Object.fromEntries(
      movesFrom(this.playbook, req.currentBlock).map((m) => [m.key, m.to === label?.block ? 0.75 + this.rng() * 0.2 : this.rng() * 0.2]),
    );

    const [lo, hi] = this.latency;
    const latencyMs = lo + this.rng() * (hi - lo);
    await sleep(latencyMs, signal);

    return { seq: req.seq, block, stance, readiness, moves, classifier: this.name, latencyMs };
  }

  private noisy(ids: string[], truth: string | undefined, flipScale = 1): Probs {
    if (!truth || !ids.includes(truth)) return spread(ids, null, 1 / ids.length);
    const roll = this.rng();
    if (roll < this.vagueRate) return spread(ids, truth, 0.35 + this.rng() * 0.15);
    let peakId = truth;
    if (roll < this.vagueRate + this.flipRate * flipScale) {
      const others = ids.filter((id) => id !== truth);
      peakId = others[Math.floor(this.rng() * others.length)]!;
    }
    return spread(ids, peakId, 0.6 + this.rng() * 0.35);
  }
}

function spread(ids: string[], peakId: string | null, peak: number): Probs {
  if (!peakId) return Object.fromEntries(ids.map((id) => [id, 1 / ids.length]));
  const rest = (1 - peak) / (ids.length - 1);
  return Object.fromEntries(ids.map((id) => [id, id === peakId ? peak : rest]));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
