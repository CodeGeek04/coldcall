import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Append-only JSONL files for one session:
 * - pipeline.jsonl: every segment, evaluation, override and error, for replay and scoring
 * - unknowns.jsonl: every evaluation that showed unknown, with its transcript window
 */
export class SessionLog {
  readonly pipelinePath: string;
  readonly unknownsPath: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.pipelinePath = join(dir, "pipeline.jsonl");
    this.unknownsPath = join(dir, "unknowns.jsonl");
  }

  write(record: { type: string } & Record<string, unknown>): void {
    appendFileSync(this.pipelinePath, JSON.stringify(record) + "\n");
  }

  unknown(record: Record<string, unknown>): void {
    appendFileSync(this.unknownsPath, JSON.stringify(record) + "\n");
  }
}

/** sessions/20261117-130102-replay-sample-call */
export function sessionDir(kind: string, name: string, root = "sessions"): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60);
  return join(root, `${stamp}-${kind}-${safe}`);
}
