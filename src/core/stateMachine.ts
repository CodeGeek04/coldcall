import { directionFor, movesFrom, nextHints, type Playbook } from "./playbook";
import type { ClassifyResult, DisplayState, ProbEntry, Probs } from "./types";

/** Starting values from PLAN.md "State logic". Tune on recordings. */
export interface Tuning {
  /** Rule 1: top block under this shows unknown. */
  unknownBelow: number;
  /** Rule 2: a challenger at or above this counts toward a switch. */
  switchConsecutive: number;
  /** Rule 2: consecutive leading results needed at switchConsecutive. */
  consecutiveNeeded: number;
  /** Rule 2: a single result at or above this switches at once. */
  switchOnce: number;
  /** Rule 3: both thresholds drop by this for a block in the current block's `next`. */
  nextHintBonus: number;
  /** Rule 5: top two within this are shown as a tie. */
  tieWithin: number;
  /** Rule 4: results in the stance and readiness moving average. */
  smoothWindow: number;
  /** Rule 7: how long a manual override holds. */
  pinMs: number;
  /** Next move: a trigger at or above this lights the next block. */
  moveShowAt: number;
  /** Next move: a shown suggestion is dropped after this many results under moveClearBelow. */
  moveClearBelow: number;
  moveClearAfter: number;
}

export const DEFAULT_TUNING: Tuning = {
  unknownBelow: 0.55,
  switchConsecutive: 0.65,
  consecutiveNeeded: 2,
  switchOnce: 0.85,
  nextHintBonus: 0.05,
  tieWithin: 0.15,
  smoothWindow: 3,
  pinMs: 15_000,
  moveShowAt: 0.7,
  moveClearBelow: 0.3,
  moveClearAfter: 2,
};

export interface ApplyOutcome {
  stale: boolean;
  state: DisplayState;
}

/**
 * Turns raw classifier probabilities into a calm display.
 * Plain code, no model inside, and time is passed in, so replay and live run the same rules.
 */
export class StanceStateMachine {
  private lastSeq = 0;
  private block: string | null = null;
  private unknown = true;
  private challenger: { id: string; count: number } | null = null;
  private pinned: { block: string; untilMs: number } | null = null;
  private stanceHistory: Probs[] = [];
  private readinessHistory: number[] = [];
  private latestBlockProbs: Probs | null = null;
  private next: { key: string; to: string; because: string; p: number; from: string; weak: number } | null = null;
  private current: DisplayState;

  constructor(
    private readonly playbook: Playbook,
    readonly tuning: Tuning = DEFAULT_TUNING,
  ) {
    this.current = this.snapshot(0, false);
  }

  get state(): DisplayState {
    return this.current;
  }

  apply(result: ClassifyResult, nowMs: number): ApplyOutcome {
    // Rule 6: drop anything older than what is on screen.
    if (result.seq <= this.lastSeq) return { stale: true, state: this.current };
    this.lastSeq = result.seq;

    // Rule 4: short moving average for stance and readiness.
    this.stanceHistory = [...this.stanceHistory, result.stance].slice(-this.tuning.smoothWindow);
    this.readinessHistory = [...this.readinessHistory, result.readiness].slice(-this.tuning.smoothWindow);
    this.latestBlockProbs = result.block;

    this.expirePin(nowMs);
    const before = this.block;
    const top = ranked(result.block)[0];

    if (this.pinned) {
      // Rule 7: the override holds the block; results still move stance and readiness.
      this.unknown = false;
      this.challenger = null;
    } else if (!top || top.p < this.tuning.unknownBelow) {
      // Rule 1: nothing clear. Keep the last confident block, dimmed.
      this.unknown = true;
      this.challenger = null;
    } else if (this.block === null) {
      // Nothing on screen yet, so there is no flicker to guard against.
      if (top.p >= this.tuning.switchConsecutive) {
        this.block = top.id;
        this.unknown = false;
      } else {
        this.unknown = true;
      }
    } else if (top.id === this.block) {
      this.unknown = false;
      this.challenger = null;
    } else {
      this.unknown = false;
      this.considerChallenger(top);
    }

    this.updateNext(result);
    this.current = this.snapshot(nowMs, this.block !== before);
    return { stale: false, state: this.current };
  }

  /** Rule 7: pin a block (manual override). The caller logs it as a ground-truth label. */
  pin(block: string, nowMs: number): DisplayState {
    if (!this.playbook.blocks.some((b) => b.id === block)) {
      throw new Error(`unknown block "${block}"`);
    }
    const before = this.block;
    this.pinned = { block, untilMs: nowMs + this.tuning.pinMs };
    this.block = block;
    this.unknown = false;
    this.challenger = null;
    this.current = this.snapshot(nowMs, this.block !== before);
    return this.current;
  }

  /** Expires a pin between results. Returns the new state if anything changed, else null. */
  tick(nowMs: number): DisplayState | null {
    if (!this.expirePin(nowMs)) return null;
    this.current = this.snapshot(nowMs, false);
    return this.current;
  }

  private expirePin(nowMs: number): boolean {
    if (this.pinned && nowMs >= this.pinned.untilMs) {
      this.pinned = null;
      return true;
    }
    return false;
  }

  /**
   * Next move: a trigger for leaving the current block that is clearly true lights the block to
   * go to. It holds until you get there, the block changes, a stronger trigger wins, or its own
   * trigger reads clearly false twice.
   */
  private updateNext(result: ClassifyResult): void {
    const t = this.tuning;
    const block = this.block;
    if (this.next && (block === this.next.to || block !== this.next.from)) this.next = null;
    if (!block || !result.moves) return;

    const scored = movesFrom(this.playbook, block)
      .map((m) => ({ m, p: result.moves?.[m.key] }))
      .filter((x): x is { m: (typeof x)["m"]; p: number } => x.p !== undefined);

    if (this.next) {
      const shown = scored.find((x) => x.m.key === this.next?.key);
      if (shown) {
        this.next.p = shown.p;
        this.next.weak = shown.p < t.moveClearBelow ? this.next.weak + 1 : 0;
        if (this.next.weak >= t.moveClearAfter) this.next = null;
      }
    }

    const best = scored.filter((x) => x.p >= t.moveShowAt).sort((a, b) => b.p - a.p)[0];
    if (best && (!this.next || (best.m.key !== this.next.key && best.p > this.next.p))) {
      this.next = { key: best.m.key, to: best.m.to, because: best.m.because, p: best.p, from: block, weak: 0 };
    }
  }

  /** Rules 2 and 3. */
  private considerChallenger(top: ProbEntry): void {
    const t = this.tuning;
    const hinted = this.block !== null && nextHints(this.playbook, this.block).includes(top.id);
    const bonus = hinted ? t.nextHintBonus : 0;

    if (top.p >= t.switchOnce - bonus) {
      this.switchTo(top.id);
      return;
    }
    if (top.p >= t.switchConsecutive - bonus) {
      const count = this.challenger?.id === top.id ? this.challenger.count + 1 : 1;
      this.challenger = { id: top.id, count };
      if (count >= t.consecutiveNeeded) this.switchTo(top.id);
      return;
    }
    this.challenger = null;
  }

  private switchTo(block: string): void {
    this.block = block;
    this.challenger = null;
  }

  private snapshot(nowMs: number, switched: boolean): DisplayState {
    const stanceAvg = average(this.stanceHistory);
    const topStance = ranked(stanceAvg)[0] ?? null;
    const latest = this.latestBlockProbs ? ranked(this.latestBlockProbs) : [];
    const [first, second] = latest;
    const tie: [ProbEntry, ProbEntry] | null =
      first && second && first.p - second.p <= this.tuning.tieWithin ? [first, second] : null;
    const stance = topStance?.id ?? null;
    const unknown = this.unknown || this.block === null;

    return {
      seq: this.lastSeq,
      atMs: nowMs,
      block: this.block,
      unknown,
      pinned: this.pinned ? { ...this.pinned } : null,
      tie,
      top: first ?? null,
      stance,
      stanceConfidence: topStance?.p ?? 0,
      readiness: this.readinessHistory.length
        ? this.readinessHistory.reduce((a, b) => a + b, 0) / this.readinessHistory.length
        : null,
      next: this.next ? { block: this.next.to, because: this.next.because, p: this.next.p } : null,
      // What to do next wins over where you are; a clear trigger beats an unclear block.
      direction: this.next
        ? directionFor(this.playbook, this.next.to, stance)
        : unknown || this.block === null
          ? this.playbook.unknown_direction
          : directionFor(this.playbook, this.block, stance),
      switched,
    };
  }
}

/** Highest probability first. Ties keep the input order, so results are deterministic. */
export function ranked(probs: Probs): ProbEntry[] {
  return Object.entries(probs)
    .map(([id, p]) => ({ id, p }))
    .sort((a, b) => b.p - a.p);
}

function average(list: Probs[]): Probs {
  if (!list.length) return {};
  const sum: Probs = {};
  for (const probs of list) {
    for (const [id, p] of Object.entries(probs)) sum[id] = (sum[id] ?? 0) + p;
  }
  for (const id of Object.keys(sum)) sum[id] = sum[id]! / list.length;
  return sum;
}
