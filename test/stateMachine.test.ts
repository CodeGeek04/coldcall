import { describe, expect, it } from "vitest";
import { parsePlaybook } from "../src/core/playbook";
import { StanceStateMachine } from "../src/core/stateMachine";
import type { ClassifyResult, Probs } from "../src/core/types";

const pb = parsePlaybook(`
blocks:
  - { id: opener, describe: x, next: [hook] }
  - { id: hook, describe: x, next: [discovery] }
  - { id: discovery, describe: x, next: [] }
  - { id: reluctant, describe: x, next: [] }
stances:
  - { id: open, describe: x }
  - { id: reluctant, describe: x }
  - { id: hostile, describe: x }
readiness: [low, high]
directions:
  reluctant: { default: R default, by_stance: { hostile: R hostile } }
  discovery: { default: D default }
unknown_direction: Unclear.
`);

/** Puts `p` on `top` and spreads the rest evenly over the other blocks. */
function peak(top: string, p: number): Probs {
  const ids = pb.blocks.map((b) => b.id);
  const rest = (1 - p) / (ids.length - 1);
  return Object.fromEntries(ids.map((id) => [id, id === top ? p : rest]));
}

let seq = 0;
function res(block: Probs, stance: Probs = { open: 1 }, readiness = 0.5): ClassifyResult {
  seq += 1;
  return { seq, block, stance, readiness, classifier: "test", latencyMs: 0 };
}

function machineLitOn(block: string) {
  const sm = new StanceStateMachine(pb);
  sm.apply(res(peak(block, 0.9)), 0);
  expect(sm.state.block).toBe(block);
  return sm;
}

describe("first block", () => {
  it("starts with nothing lit and the unknown direction", () => {
    const sm = new StanceStateMachine(pb);
    expect(sm.state.block).toBeNull();
    expect(sm.state.unknown).toBe(true);
    expect(sm.state.direction).toBe("Unclear.");
  });

  it("lights the first block at once when it is at least 0.65", () => {
    const sm = new StanceStateMachine(pb);
    const { state } = sm.apply(res(peak("opener", 0.7)), 0);
    expect(state.block).toBe("opener");
    expect(state.unknown).toBe(false);
    expect(state.switched).toBe(true);
  });

  it("keeps nothing lit while the first results are under 0.65", () => {
    const sm = new StanceStateMachine(pb);
    sm.apply(res(peak("opener", 0.6)), 0);
    expect(sm.state.block).toBeNull();
    expect(sm.state.unknown).toBe(true);
  });
});

describe("rule 1: unknown", () => {
  it("dims and keeps the last confident block when the top is under 0.55", () => {
    const sm = machineLitOn("discovery");
    const { state } = sm.apply(res(peak("reluctant", 0.5)), 0);
    expect(state.unknown).toBe(true);
    expect(state.block).toBe("discovery");
    expect(state.direction).toBe("Unclear.");
    expect(state.switched).toBe(false);
  });

  it("undims when the next result is confident again", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.5)), 0);
    sm.apply(res(peak("discovery", 0.7)), 0);
    expect(sm.state.unknown).toBe(false);
    expect(sm.state.direction).toBe("D default");
  });
});

describe("rule 2: block switch", () => {
  it("needs 2 consecutive results of at least 0.65", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.7)), 0);
    expect(sm.state.block).toBe("discovery");
    const { state } = sm.apply(res(peak("reluctant", 0.7)), 0);
    expect(state.block).toBe("reluctant");
    expect(state.switched).toBe(true);
  });

  it("resets the challenger when the current block leads in between", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.7)), 0);
    sm.apply(res(peak("discovery", 0.8)), 0);
    sm.apply(res(peak("reluctant", 0.7)), 0);
    expect(sm.state.block).toBe("discovery");
  });

  it("resets the challenger when a different challenger leads", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.7)), 0);
    sm.apply(res(peak("opener", 0.7)), 0);
    expect(sm.state.block).toBe("discovery");
  });

  it("resets the challenger on an unknown result", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.7)), 0);
    sm.apply(res(peak("reluctant", 0.5)), 0);
    sm.apply(res(peak("reluctant", 0.7)), 0);
    expect(sm.state.block).toBe("discovery");
  });

  it("does not count a challenger between 0.55 and 0.65", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.6)), 0);
    sm.apply(res(peak("reluctant", 0.6)), 0);
    sm.apply(res(peak("reluctant", 0.6)), 0);
    expect(sm.state.block).toBe("discovery");
    expect(sm.state.unknown).toBe(false);
  });

  it("switches on a single result of at least 0.85", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("reluctant", 0.86)), 0);
    expect(sm.state.block).toBe("reluctant");
  });
});

describe("rule 3: backward moves and next hints", () => {
  it("allows backward moves with the same thresholds", () => {
    const sm = machineLitOn("discovery");
    sm.apply(res(peak("opener", 0.9)), 0);
    expect(sm.state.block).toBe("opener");
  });

  it("lowers the single-result threshold for a hinted next block", () => {
    const sm = machineLitOn("opener"); // next: [hook]
    sm.apply(res(peak("discovery", 0.82)), 0);
    expect(sm.state.block).toBe("opener");
    sm.apply(res(peak("hook", 0.82)), 0);
    expect(sm.state.block).toBe("hook");
  });

  it("lowers the consecutive threshold for a hinted next block", () => {
    const sm = machineLitOn("opener");
    sm.apply(res(peak("hook", 0.61)), 0);
    sm.apply(res(peak("hook", 0.61)), 0);
    expect(sm.state.block).toBe("hook");
  });

  it("does not lower thresholds for an unhinted block", () => {
    const sm = machineLitOn("opener");
    sm.apply(res(peak("discovery", 0.61)), 0);
    sm.apply(res(peak("discovery", 0.61)), 0);
    expect(sm.state.block).toBe("opener");
  });
});

describe("rule 4: stance smoothing", () => {
  it("averages stance over the last 3 results", () => {
    const sm = machineLitOn("discovery"); // stance open
    sm.apply(res(peak("discovery", 0.9), { reluctant: 1 }), 0);
    sm.apply(res(peak("discovery", 0.9), { reluctant: 1 }), 0);
    expect(sm.state.stance).toBe("reluctant");
    expect(sm.state.stanceConfidence).toBeCloseTo(2 / 3);
    sm.apply(res(peak("discovery", 0.9), { reluctant: 1 }), 0);
    expect(sm.state.stanceConfidence).toBeCloseTo(1);
  });

  it("averages readiness over the last 3 results", () => {
    const sm = new StanceStateMachine(pb);
    sm.apply(res(peak("discovery", 0.9), { open: 1 }, 0.3), 0);
    sm.apply(res(peak("discovery", 0.9), { open: 1 }, 0.6), 0);
    expect(sm.state.readiness).toBeCloseTo(0.45);
  });

  it("picks the direction by smoothed stance", () => {
    const sm = machineLitOn("reluctant");
    expect(sm.state.direction).toBe("R default");
    sm.apply(res(peak("reluctant", 0.9), { hostile: 1 }), 0);
    sm.apply(res(peak("reluctant", 0.9), { hostile: 1 }), 0);
    expect(sm.state.stance).toBe("hostile");
    expect(sm.state.direction).toBe("R hostile");
  });

  it("gives an empty direction for a block with none written", () => {
    const sm = machineLitOn("opener");
    expect(sm.state.direction).toBe("");
  });
});

describe("rule 5: near ties", () => {
  it("shows the top two when they are within 0.15", () => {
    const sm = machineLitOn("discovery");
    const { state } = sm.apply(res({ discovery: 0.45, reluctant: 0.4, opener: 0.1, hook: 0.05 }), 0);
    expect(state.tie).toEqual([
      { id: "discovery", p: 0.45 },
      { id: "reluctant", p: 0.4 },
    ]);
  });

  it("shows no tie when the gap is larger", () => {
    const sm = machineLitOn("discovery");
    const { state } = sm.apply(res({ discovery: 0.7, reluctant: 0.2, opener: 0.05, hook: 0.05 }), 0);
    expect(state.tie).toBeNull();
  });
});

describe("rule 6: stale results", () => {
  it("drops a result older than the one on screen", () => {
    const sm = new StanceStateMachine(pb);
    const newer: ClassifyResult = { seq: 10, block: peak("discovery", 0.9), stance: { open: 1 }, readiness: 0.5, classifier: "t", latencyMs: 0 };
    const older: ClassifyResult = { ...newer, seq: 9, block: peak("reluctant", 0.99) };
    sm.apply(newer, 0);
    const out = sm.apply(older, 0);
    expect(out.stale).toBe(true);
    expect(sm.state.block).toBe("discovery");
    expect(sm.state.seq).toBe(10);
  });
});

describe("rule 7: manual override", () => {
  it("pins a block for 15 s regardless of results", () => {
    const sm = machineLitOn("discovery");
    sm.pin("reluctant", 1_000);
    expect(sm.state.block).toBe("reluctant");
    expect(sm.state.pinned).toEqual({ block: "reluctant", untilMs: 16_000 });
    sm.apply(res(peak("opener", 0.95)), 5_000);
    sm.apply(res(peak("opener", 0.3)), 6_000);
    expect(sm.state.block).toBe("reluctant");
    expect(sm.state.unknown).toBe(false);
  });

  it("returns to the normal rules after the pin expires, from the pinned block", () => {
    const sm = machineLitOn("discovery");
    sm.pin("reluctant", 1_000);
    sm.apply(res(peak("opener", 0.7)), 17_000);
    expect(sm.state.pinned).toBeNull();
    expect(sm.state.block).toBe("reluctant");
    sm.apply(res(peak("opener", 0.7)), 18_000);
    expect(sm.state.block).toBe("opener");
  });

  it("expires the pin on tick without a new result", () => {
    const sm = machineLitOn("discovery");
    sm.pin("reluctant", 1_000);
    expect(sm.tick(10_000)).toBeNull();
    const after = sm.tick(16_000);
    expect(after?.pinned).toBeNull();
    expect(after?.block).toBe("reluctant");
  });

  it("rejects a block that is not in the playbook", () => {
    const sm = new StanceStateMachine(pb);
    expect(() => sm.pin("nope", 0)).toThrow();
  });
});

describe("next move", () => {
  const mpb = parsePlaybook(`
blocks:
  - { id: discovery, describe: x }
  - { id: pitch, describe: x }
  - { id: ask, describe: x }
  - { id: exit, describe: x }
stances:
  - { id: open, describe: x }
  - { id: ready, describe: x }
readiness: [low, high]
moves:
  - { to: pitch, from: [discovery], when: named a problem, because: they named a problem }
  - { to: ask, from: [discovery, pitch], when: showed interest, because: they showed interest }
  - { to: exit, from: any, when: ending, because: they are ending the call }
directions:
  discovery: { default: D }
  pitch: { default: P }
  ask: { default: A }
unknown_direction: Unclear.
`);
  const ids = mpb.blocks.map((b) => b.id);
  const on = (top: string, p = 0.95): Probs => Object.fromEntries(ids.map((id) => [id, id === top ? p : (1 - p) / (ids.length - 1)]));
  // Move keys are move_<index>_<to>, in playbook order.
  const PITCH = "move_0_pitch";
  const ASK = "move_1_ask";
  const EXIT = "move_2_exit";
  let n = 0;
  const r = (block: Probs, moves: Probs = {}): ClassifyResult => ({ seq: ++n, block, stance: { open: 1 }, readiness: 0.5, moves, classifier: "t", latencyMs: 0 });

  function inDiscovery() {
    const sm = new StanceStateMachine(mpb);
    sm.apply(r(on("discovery")), 0);
    return sm;
  }

  it("lights the next block once its trigger is at least 0.7, with the reason and that block's direction", () => {
    const sm = inDiscovery();
    const { state } = sm.apply(r(on("discovery"), { [PITCH]: 0.9, [ASK]: 0.1, [EXIT]: 0.0 }), 0);
    expect(state.block).toBe("discovery");
    expect(state.next).toEqual({ block: "pitch", because: "they named a problem", p: 0.9 });
    expect(state.direction).toBe("P");
  });

  it("ignores triggers under 0.7", () => {
    const sm = inDiscovery();
    sm.apply(r(on("discovery"), { [PITCH]: 0.6 }), 0);
    expect(sm.state.next).toBeNull();
    expect(sm.state.direction).toBe("D");
  });

  it("clears once the lit block reaches the suggestion", () => {
    const sm = inDiscovery();
    sm.apply(r(on("discovery"), { [PITCH]: 0.9 }), 0);
    sm.apply(r(on("pitch")), 0);
    expect(sm.state.block).toBe("pitch");
    expect(sm.state.next).toBeNull();
    expect(sm.state.direction).toBe("P");
  });

  it("ignores a move that does not leave the current block", () => {
    const sm = new StanceStateMachine(mpb);
    sm.apply(r(on("ask")), 0);
    sm.apply(r(on("ask"), { [PITCH]: 0.99 }), 0);
    expect(sm.state.next).toBeNull();
  });

  it("lets a stronger trigger replace the shown one", () => {
    const sm = inDiscovery();
    sm.apply(r(on("discovery"), { [PITCH]: 0.75 }), 0);
    sm.apply(r(on("discovery"), { [PITCH]: 0.72, [ASK]: 0.92 }), 0);
    expect(sm.state.next?.block).toBe("ask");
  });

  it("keeps the suggestion through one weak result, drops it after two", () => {
    const sm = inDiscovery();
    sm.apply(r(on("discovery"), { [PITCH]: 0.9 }), 0);
    sm.apply(r(on("discovery"), { [PITCH]: 0.1 }), 0);
    expect(sm.state.next?.block).toBe("pitch");
    sm.apply(r(on("discovery"), { [PITCH]: 0.1 }), 0);
    expect(sm.state.next).toBeNull();
  });

  it("keeps showing the next move while the block itself is unclear", () => {
    const sm = inDiscovery();
    const { state } = sm.apply(r(on("discovery", 0.4), { [EXIT]: 0.85 }), 0);
    expect(state.unknown).toBe(true);
    expect(state.next?.block).toBe("exit");
    expect(state.direction).toBe("");
  });
});
