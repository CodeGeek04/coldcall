import { z } from "zod";
import { movesFrom, type Playbook } from "../core/playbook";
import type { ClassifyRequest, ClassifyResult, Classifier, Segment } from "../core/types";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Instructions refer to fields of `state` by backtick path, as the TypeSafe docs suggest.
const BLOCK_INSTRUCTIONS =
  "This is a live cold sales call. In `conversation`, `You` is the caller (the salesperson) and " +
  "`Them` is the person who was called. `conversation` holds the most recent turns, oldest first. " +
  "`current_block` is the stage the call was in before the latest turns. " +
  "Which stage is the call in now, judged by the latest turns of `conversation`?";

const STANCE_INSTRUCTIONS =
  "This is a live cold sales call. In `conversation`, `Them` is the person who was called. " +
  "What is their attitude right now, judged by their latest turns in `conversation`?";

// One yes/no question per move out of the current block; the move's `when` follows.
const MOVE_INSTRUCTIONS =
  "This is a live cold sales call. In `conversation`, `You` is the caller and `Them` is the person who was called. " +
  "Judge only the latest turns of `conversation`. Is this true? ";

const READINESS_INSTRUCTIONS =
  "This is a live cold sales call. In `conversation`, `Them` is the person who was called. " +
  "How ready are they to take a next step with the caller, judged by `conversation`?";

export interface JevRequestBody {
  model: string;
  state: {
    current_block: string;
    conversation: { from: "You" | "Them"; text: string }[];
  };
  questions: {
    block: { type: "choice"; instructions: string; criteria: Record<string, string | { what: string; examples: string[] }> };
    stance: { type: "choice"; instructions: string; criteria: Record<string, string> };
    readiness: { type: "score"; instructions: string; criteria: string[] };
    /** One per move out of the current block. */
    [move: `move_${string}`]: { type: "noul"; instructions: string };
  };
}

/** Labeled text plus the current block. Ground-truth labels on segments are never sent. */
export function buildJevRequest(playbook: Playbook, window: Segment[], currentBlock: string | null, model: string): JevRequestBody {
  return {
    model,
    state: {
      current_block: currentBlock ?? "none yet",
      conversation: window.map((s) => ({ from: s.speaker === "you" ? "You" : "Them", text: s.text })),
    },
    questions: {
      block: {
        type: "choice",
        instructions: BLOCK_INSTRUCTIONS,
        criteria: Object.fromEntries(
          playbook.blocks.map((b) => [b.id, b.examples?.length ? { what: b.describe, examples: b.examples } : b.describe]),
        ),
      },
      stance: {
        type: "choice",
        instructions: STANCE_INSTRUCTIONS,
        criteria: Object.fromEntries(playbook.stances.map((s) => [s.id, s.describe])),
      },
      readiness: {
        type: "score",
        instructions: READINESS_INSTRUCTIONS,
        criteria: playbook.readiness,
      },
      ...Object.fromEntries(movesFrom(playbook, currentBlock).map((m) => [m.key, { type: "noul" as const, instructions: MOVE_INSTRUCTIONS + m.when }])),
    },
  };
}

const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const NoulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

export const JevResponseSchema = z.object({
  model: z.string(),
  answers: z
    .object({
      block: ChoiceAnswer,
      stance: ChoiceAnswer,
      readiness: ScoreAnswer,
    })
    // Move answers, named after the moves asked about.
    .catchall(z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export type JevResponse = z.infer<typeof JevResponseSchema>;

export class JevError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Jev request failed with HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

export interface JevOptions {
  apiKey: string;
  model?: string;
  /** Per-request timeout. A result this late is useless on a live call. */
  timeoutMs?: number;
  endpoint?: string;
}

export class JevClassifier implements Classifier {
  readonly name: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(
    private readonly playbook: Playbook,
    private readonly opts: JevOptions,
  ) {
    this.model = opts.model ?? "jev-latest";
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.endpoint = opts.endpoint ?? JEV_ENDPOINT;
    this.name = `jev:${this.model}`;
  }

  async classify(req: ClassifyRequest, signal?: AbortSignal): Promise<ClassifyResult> {
    const body = buildJevRequest(this.playbook, req.window, req.currentBlock, this.model);
    const started = performance.now();
    const res = await this.send(body, signal);
    const latencyMs = performance.now() - started;
    return toResult(req.seq, res, this.playbook.readiness.length, latencyMs);
  }

  /** One retry on 429 (rate limit) and 529 (overloaded); anything else fails fast. */
  async send(body: JevRequestBody, signal?: AbortSignal): Promise<JevResponse> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) return JevResponseSchema.parse(await res.json());
      const text = await res.text();
      if (attempt === 0 && (res.status === 429 || res.status === 529)) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw new JevError(res.status, text);
    }
  }
}

/** Score comes back as a probability-weighted level index (0 to levels-1); scale it to 0 to 1. */
export function toResult(seq: number, res: JevResponse, readinessLevels: number, latencyMs: number): ClassifyResult {
  const moves: Record<string, number> = {};
  for (const [key, answer] of Object.entries(res.answers)) {
    if (!key.startsWith("move_")) continue;
    const parsed = NoulAnswer.safeParse(answer);
    if (parsed.success) moves[key] = parsed.data.noul;
  }
  return {
    seq,
    block: res.answers.block.probabilities,
    stance: res.answers.stance.probabilities,
    readiness: readinessLevels > 1 ? res.answers.readiness.score / (readinessLevels - 1) : 0,
    moves,
    classifier: `jev:${res.model}`,
    latencyMs,
    inputTokens: res.usage.input_tokens,
    raw: res.answers,
  };
}
