import { describe, expect, it } from "vitest";
import { directionFor, loadPlaybook, parsePlaybook } from "../src/core/playbook";

describe("playbook.yaml", () => {
  it("loads and validates the real file", () => {
    const pb = loadPlaybook("playbook.yaml");
    expect(pb.blocks.map((b) => b.id)).toContain("reluctant");
    expect(pb.stances.map((s) => s.id)).toEqual(["open", "neutral", "reluctant", "hostile", "ready"]);
    expect(pb.unknown_direction).toBe("Unclear. It is on you.");
  });

  it("prefers the stance-specific direction over the default", () => {
    const pb = loadPlaybook("playbook.yaml");
    expect(directionFor(pb, "reluctant", "hostile")).toBe("Thank them, ask permission to follow up once, exit.");
    expect(directionFor(pb, "reluctant", "neutral")).toBe("Name the objection back, ask one soft question, do not pitch.");
    expect(directionFor(pb, "discovery", "ready")).toBe("Stop discovering; move to the ask.");
  });
});

describe("moves", () => {
  it("lists the moves out of a block, including moves from any block", async () => {
    const { movesFrom } = await import("../src/core/playbook");
    const pb = loadPlaybook("playbook.yaml");
    expect(movesFrom(pb, "discovery").map((m) => m.to)).toEqual(["pitch", "ask", "reluctant", "exit"]);
    expect(movesFrom(pb, "logistics").map((m) => m.to)).toEqual(["exit", "exit"]);
    expect(movesFrom(pb, null)).toEqual([]);
  });

  it("rejects a move to a block that does not exist", () => {
    const text = `
blocks:
  - { id: a, describe: x }
  - { id: b, describe: x }
stances:
  - { id: calm, describe: x }
  - { id: angry, describe: x }
readiness: [low, high]
moves:
  - { to: zzz, from: [a], when: x, because: y }
unknown_direction: Unclear.
`;
    expect(() => parsePlaybook(text)).toThrow(/unknown block "zzz"/);
  });
});

describe("parsePlaybook", () => {
  const base = (extra: string) => `
blocks:
  - { id: a, describe: x, next: [b] }
  - { id: b, describe: x }
stances:
  - { id: calm, describe: x }
  - { id: angry, describe: x }
readiness: [low, high]
unknown_direction: Unclear.
${extra}`;

  it("rejects a next hint to a block that does not exist", () => {
    expect(() => parsePlaybook(base("").replace("next: [b]", "next: [zzz]"))).toThrow(/unknown next block "zzz"/);
  });

  it("rejects directions for an unknown block or stance", () => {
    expect(() => parsePlaybook(base("directions:\n  nope: { default: hi }"))).toThrow(/unknown block "nope"/);
    expect(() => parsePlaybook(base("directions:\n  a: { by_stance: { sad: hi } }"))).toThrow(/unknown stance "sad"/);
  });

  it("rejects more than 10 readiness levels (the Jev Score limit)", () => {
    const levels = Array.from({ length: 11 }, (_, i) => `l${i}`).join(", ");
    expect(() => parsePlaybook(base("").replace("[low, high]", `[${levels}]`))).toThrow();
  });
});
