import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/, "ids are lowercase letters, digits and underscores");

const BlockSchema = z.object({
  id: Id,
  describe: z.string().min(1),
  next: z.array(Id).default([]),
  examples: z.array(z.string().min(1)).optional(),
});

const StanceSchema = z.object({
  id: Id,
  describe: z.string().min(1),
});

const MoveSchema = z.object({
  to: Id,
  from: z.union([z.literal("any"), z.array(Id).min(1)]),
  when: z.string().min(1),
  because: z.string().min(1),
});

const DirectionSchema = z.object({
  default: z.string().optional(),
  by_stance: z.record(z.string(), z.string()).optional(),
});

const PlaybookSchema = z.object({
  blocks: z.array(BlockSchema).min(2),
  stances: z.array(StanceSchema).min(2),
  // Jev Score accepts 2 to 10 levels.
  readiness: z.array(z.string().min(1)).min(2).max(10),
  moves: z.array(MoveSchema).default([]),
  directions: z.record(z.string(), DirectionSchema).default({}),
  unknown_direction: z.string().min(1),
});

export type Playbook = z.infer<typeof PlaybookSchema>;
export type Block = Playbook["blocks"][number];

export function parsePlaybook(text: string): Playbook {
  const pb = PlaybookSchema.parse(parse(text));
  const problems: string[] = [];

  const blockIds = new Set<string>();
  for (const b of pb.blocks) {
    if (blockIds.has(b.id)) problems.push(`duplicate block id "${b.id}"`);
    blockIds.add(b.id);
  }
  const stanceIds = new Set<string>();
  for (const s of pb.stances) {
    if (stanceIds.has(s.id)) problems.push(`duplicate stance id "${s.id}"`);
    stanceIds.add(s.id);
  }
  for (const b of pb.blocks) {
    for (const n of b.next) {
      if (!blockIds.has(n)) problems.push(`block "${b.id}" lists unknown next block "${n}"`);
    }
  }
  pb.moves.forEach((m, i) => {
    if (!blockIds.has(m.to)) problems.push(`moves[${i}] goes to unknown block "${m.to}"`);
    if (m.from !== "any") {
      for (const f of m.from) if (!blockIds.has(f)) problems.push(`moves[${i}] comes from unknown block "${f}"`);
      if (m.from.includes(m.to)) problems.push(`moves[${i}] goes from "${m.to}" to itself`);
    }
  });
  for (const [blockId, d] of Object.entries(pb.directions)) {
    if (!blockIds.has(blockId)) problems.push(`directions name unknown block "${blockId}"`);
    for (const stanceId of Object.keys(d.by_stance ?? {})) {
      if (!stanceIds.has(stanceId)) {
        problems.push(`directions.${blockId}.by_stance names unknown stance "${stanceId}"`);
      }
    }
  }
  if (problems.length) throw new Error(`playbook.yaml is invalid:\n- ${problems.join("\n- ")}`);
  return pb;
}

export function loadPlaybook(path = "playbook.yaml"): Playbook {
  return parsePlaybook(readFileSync(path, "utf8"));
}

/** A stance-specific line wins over the block's default. Empty string when none is written. */
export function directionFor(pb: Playbook, block: string, stance: string | null): string {
  const d = pb.directions[block];
  if (!d) return "";
  return (stance && d.by_stance?.[stance]) || d.default || "";
}

export function nextHints(pb: Playbook, block: string): readonly string[] {
  return pb.blocks.find((b) => b.id === block)?.next ?? [];
}

export interface Move {
  /** Stable id for this move: its question name in Jev requests and its key in results. */
  key: string;
  to: string;
  from: "any" | string[];
  when: string;
  because: string;
}

/** The moves that leave `block`, in playbook order. None before the first block lights. */
export function movesFrom(pb: Playbook, block: string | null): Move[] {
  if (!block) return [];
  return pb.moves
    .map((m, i) => ({ ...m, key: `move_${i}_${m.to}` }))
    .filter((m) => m.to !== block && (m.from === "any" || m.from.includes(block)));
}
