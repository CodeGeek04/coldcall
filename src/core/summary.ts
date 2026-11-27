import type { Evaluation } from "./pipeline";

export interface Summary {
  evaluations: number;
  stale: number;
  failures: number;
  callMinutes: number;
  blockAgreement: Ratio | null;
  stanceAgreement: Ratio | null;
  unknown: Ratio;
  /** Lit block changed (not counting the first block lighting up). */
  switches: number;
  switchesPerMinute: number;
  /** Switches to a block that disagrees with the hand label at that segment. */
  wrongSwitches: Ratio | null;
  lagMs: Percentiles | null;
  /** Share of updates within the 1.5 s target. */
  lagWithinTarget: Ratio | null;
  latencyMs: Percentiles | null;
  inputTokens: number;
}

export interface Ratio {
  hit: number;
  of: number;
}

export interface Percentiles {
  p50: number;
  p90: number;
  max: number;
}

export const LAG_TARGET_MS = 1500;

/** Quick numbers for one run. The milestone 7 scoring script will refine these definitions. */
export function summarize(evals: Evaluation[], failures: number, callMs: number): Summary {
  const applied = evals.filter((e) => !e.stale);
  const callMinutes = callMs / 60_000;

  const blockLabeled = applied.filter((e) => e.segment.label?.block);
  const stanceLabeled = applied.filter((e) => e.segment.label?.stance);

  let switches = 0;
  let wrong = 0;
  let labeledSwitches = 0;
  let prev: string | null = null;
  for (const e of applied) {
    if (e.state.block !== prev && prev !== null) {
      switches++;
      const truth = e.segment.label?.block;
      if (truth) {
        labeledSwitches++;
        if (truth !== e.state.block) wrong++;
      }
    }
    prev = e.state.block;
  }

  const lags = applied.map((e) => e.lagMs);
  return {
    evaluations: evals.length,
    stale: evals.length - applied.length,
    failures,
    callMinutes,
    blockAgreement: blockLabeled.length
      ? { hit: blockLabeled.filter((e) => !e.state.unknown && e.state.block === e.segment.label?.block).length, of: blockLabeled.length }
      : null,
    stanceAgreement: stanceLabeled.length
      ? { hit: stanceLabeled.filter((e) => e.state.stance === e.segment.label?.stance).length, of: stanceLabeled.length }
      : null,
    unknown: { hit: applied.filter((e) => e.state.unknown).length, of: applied.length },
    switches,
    switchesPerMinute: callMinutes > 0 ? switches / callMinutes : 0,
    wrongSwitches: labeledSwitches ? { hit: wrong, of: labeledSwitches } : null,
    lagMs: percentiles(lags),
    lagWithinTarget: lags.length ? { hit: lags.filter((l) => l <= LAG_TARGET_MS).length, of: lags.length } : null,
    latencyMs: percentiles(applied.map((e) => e.result.latencyMs)),
    inputTokens: evals.reduce((n, e) => n + (e.result.inputTokens ?? 0), 0),
  };
}

export function percentiles(values: number[]): Percentiles | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return { p50: at(0.5), p90: at(0.9), max: s[s.length - 1]! };
}

export function pct(r: Ratio | null): string {
  if (!r || r.of === 0) return "n/a";
  return `${Math.round((100 * r.hit) / r.of)}% (${r.hit}/${r.of})`;
}
