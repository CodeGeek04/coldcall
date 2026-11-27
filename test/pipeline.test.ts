import { describe, expect, it } from "vitest";
import { SteppedClock } from "../src/core/clock";
import { Pipeline, type Evaluation } from "../src/core/pipeline";
import { loadPlaybook } from "../src/core/playbook";
import type { ClassifyRequest, ClassifyResult, Classifier, Segment } from "../src/core/types";

const playbook = loadPlaybook("playbook.yaml");

/** Answers each request with a fixed block after a per-request delay, so order can be forced. */
class ScriptedClassifier implements Classifier {
  readonly name = "scripted";
  readonly requests: ClassifyRequest[] = [];
  constructor(private readonly script: { block: string; delayMs: number }[]) {}
  async classify(req: ClassifyRequest): Promise<ClassifyResult> {
    this.requests.push(req);
    const step = this.script[req.seq - 1]!;
    await new Promise((r) => setTimeout(r, step.delayMs));
    return { seq: req.seq, block: { [step.block]: 0.95 }, stance: { neutral: 1 }, readiness: 0.5, classifier: this.name, latencyMs: step.delayMs };
  }
}

const seg = (i: number): Segment => ({ id: `s${i}`, speaker: i % 2 ? "them" : "you", text: `line ${i}`, start: i, end: i + 0.5 });

describe("Pipeline", () => {
  it("drops a slow older result that lands after a newer one", async () => {
    const classifier = new ScriptedClassifier([
      { block: "gatekeeper", delayMs: 60 },
      { block: "opener", delayMs: 5 },
    ]);
    const p = new Pipeline({ playbook, classifier, clock: new SteppedClock() });
    const evals: Evaluation[] = [];
    p.on("evaluation", (e) => evals.push(e));
    void p.pushFinal(seg(1));
    void p.pushFinal(seg(2));
    await p.drain();

    expect(evals.map((e) => [e.seq, e.stale])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(p.state.block).toBe("opener");
    expect(p.state.seq).toBe(2);
  });

  it("sends at most the last 8 segments and the block on screen", async () => {
    const classifier = new ScriptedClassifier(Array.from({ length: 10 }, () => ({ block: "discovery", delayMs: 0 })));
    const p = new Pipeline({ playbook, classifier, clock: new SteppedClock() });
    for (let i = 1; i <= 10; i++) await p.pushFinal(seg(i));

    const last = classifier.requests.at(-1)!;
    expect(last.window.map((s) => s.id)).toEqual(["s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
    expect(classifier.requests[0]!.currentBlock).toBeNull();
    expect(last.currentBlock).toBe("discovery");
  });

  it("reports classifier errors without stopping", async () => {
    const failing: Classifier = { name: "boom", classify: async () => Promise.reject(new Error("HTTP 529")) };
    const p = new Pipeline({ playbook, classifier: failing, clock: new SteppedClock() });
    const failures: unknown[] = [];
    p.on("failure", (f) => failures.push(f.error));
    await p.pushFinal(seg(1));
    expect(failures).toHaveLength(1);
    expect(p.state.block).toBeNull();
  });
});
