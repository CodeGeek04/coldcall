import { describe, expect, it } from "vitest";
import { buildJevRequest, JevResponseSchema, toResult } from "../src/classifiers/jev";
import { loadPlaybook, parsePlaybook } from "../src/core/playbook";
import type { Segment } from "../src/core/types";

const playbook = loadPlaybook("playbook.yaml");

const window: Segment[] = [
  { id: "s1", speaker: "you", text: "Could I have thirty seconds?", start: 0, end: 2, label: { block: "hook", stance: "neutral" } },
  { id: "s2", speaker: "them", text: "We already have a vendor.", start: 2, end: 4, label: { block: "reluctant", stance: "reluctant" } },
];

describe("buildJevRequest", () => {
  it("sends labeled text and the current block, never ground-truth labels", () => {
    const body = buildJevRequest(playbook, window, "hook", "jev-latest");
    expect(body.state).toEqual({
      current_block: "hook",
      conversation: [
        { from: "You", text: "Could I have thirty seconds?" },
        { from: "Them", text: "We already have a vendor." },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('"label"');
  });

  it("uses every playbook block and stance as an option, and readiness levels in order", () => {
    const body = buildJevRequest(playbook, window, null, "jev-latest");
    expect(body.state.current_block).toBe("none yet");
    expect(Object.keys(body.questions.block.criteria)).toEqual(playbook.blocks.map((b) => b.id));
    expect(Object.keys(body.questions.stance.criteria)).toEqual(playbook.stances.map((s) => s.id));
    expect(body.questions.readiness.criteria).toEqual(playbook.readiness);
    expect(body.questions.block.type).toBe("choice");
    expect(body.questions.readiness.type).toBe("score");
  });

  it("sends examples as an object description when a block has them", () => {
    const pb = parsePlaybook(`
blocks:
  - { id: a, describe: First, examples: ["hello there"] }
  - { id: b, describe: Second }
stances:
  - { id: x, describe: X }
  - { id: y, describe: Y }
readiness: [low, high]
unknown_direction: Unclear.
`);
    const body = buildJevRequest(pb, window, null, "jev-latest");
    expect(body.questions.block.criteria).toEqual({ a: { what: "First", examples: ["hello there"] }, b: "Second" });
  });
});

describe("move questions", () => {
  it("asks one yes/no question per move out of the current block", () => {
    const body = buildJevRequest(playbook, window, "discovery", "jev-latest");
    const moveKeys = Object.keys(body.questions).filter((k) => k.startsWith("move_"));
    const targets = moveKeys.map((k) => k.split("_").at(-1));
    expect(targets).toEqual(expect.arrayContaining(["pitch", "ask", "reluctant", "exit"]));
    expect(targets).not.toContain("discovery");
    const q = body.questions[moveKeys[0] as `move_${string}`]!;
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain("Is this true?");
  });

  it("asks no move questions before any block is lit", () => {
    const body = buildJevRequest(playbook, window, null, "jev-latest");
    expect(Object.keys(body.questions).some((k) => k.startsWith("move_"))).toBe(false);
  });

  it("reads move answers back by key", () => {
    const res = JevResponseSchema.parse({
      model: "jev-1.14.0",
      answers: {
        block: { type: "choice", choice: "discovery", confidence: 1, probabilities: { discovery: 1 } },
        stance: { type: "choice", choice: "open", confidence: 1, probabilities: { open: 1 } },
        readiness: { type: "score", score: 2, confidence: 1, legend: {}, probabilities: { "2": 1 } },
        move_3_pitch: { type: "noul", noul: 0.91 },
        move_4_ask: { type: "noul", noul: 0.12 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(toResult(1, res, 5, 0).moves).toEqual({ move_3_pitch: 0.91, move_4_ask: 0.12 });
  });
});

describe("response parsing", () => {
  // Shape as documented at docs.typesafe.ai (milestone 1 confirms it against the live API).
  const documented = {
    model: "jev-1.14.0",
    answers: {
      block: { type: "choice", choice: "reluctant", confidence: 0.8, probabilities: { reluctant: 0.82, hook: 0.1, discovery: 0.08 } },
      stance: { type: "choice", choice: "reluctant", confidence: 0.7, probabilities: { reluctant: 0.75, neutral: 0.25 } },
      readiness: { type: "score", score: 1.2, confidence: 0.6, legend: { "0": "a", "1": "b" }, probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 } },
    },
    usage: { input_tokens: 412, output_tokens: 3 },
  };

  it("accepts the documented shape", () => {
    expect(JevResponseSchema.safeParse(documented).success).toBe(true);
  });

  it("scales the readiness score to 0 to 1 by the number of levels", () => {
    const r = toResult(4, JevResponseSchema.parse(documented), 5, 300);
    expect(r.readiness).toBeCloseTo(1.2 / 4);
    expect(r.seq).toBe(4);
    expect(r.classifier).toBe("jev:jev-1.14.0");
    expect(r.inputTokens).toBe(412);
    expect(r.block.reluctant).toBe(0.82);
  });
});
