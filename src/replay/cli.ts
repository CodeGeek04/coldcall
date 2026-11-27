import { basename } from "node:path";
import { parseArgs, styleText } from "node:util";
import { JevClassifier } from "../classifiers/jev";
import { OracleMockClassifier } from "../classifiers/mock";
import { RealtimeClock, SteppedClock } from "../core/clock";
import { loadEnv } from "../core/env";
import { Pipeline, type Evaluation } from "../core/pipeline";
import { loadPlaybook } from "../core/playbook";
import { SessionLog, sessionDir } from "../core/sessionLog";
import { summarize } from "../core/summary";
import { clockLabel, formatDirection, formatEvaluation, printSummary, speakerLabel } from "../cli/format";
import { loadTranscript } from "../core/transcript";
import type { Classifier } from "../core/types";
import { replayFast, replayRealtime } from "./driver";

const USAGE = `Usage: pnpm replay <transcript.json> [options]

Options:
  --classifier jev|mock   default: jev when TYPESAFE_API_KEY is set, else mock
  --fast                  one segment at a time, no waiting between segments
  --speed <n>             real-time multiplier (default 1); lag is only meaningful at 1
  --seed <n>              mock classifier seed (default 7)
  --playbook <path>       default: playbook.yaml
  --quiet                 print the summary only
`;

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    classifier: { type: "string" },
    fast: { type: "boolean", default: false },
    speed: { type: "string", default: "1" },
    seed: { type: "string", default: "7" },
    playbook: { type: "string", default: "playbook.yaml" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.log(USAGE);
  process.exit(file ? 0 : 1);
}

const playbook = loadPlaybook(values.playbook);
const transcript = loadTranscript(file);
const kind = values.classifier ?? (process.env.TYPESAFE_API_KEY ? "jev" : "mock");

let classifier: Classifier;
if (kind === "jev") {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY is not set. Add it to .env (see .env.example) or use --classifier mock.");
    process.exit(1);
  }
  classifier = new JevClassifier(playbook, { apiKey, model: process.env.JEV_MODEL || "jev-latest" });
} else if (kind === "mock") {
  classifier = new OracleMockClassifier(playbook, { seed: Number(values.seed) });
} else {
  console.error(`Unknown classifier "${kind}". Use jev or mock.`);
  process.exit(1);
}

const speed = Number(values.speed);
const fast = values.fast;
const clock = fast ? new SteppedClock() : new RealtimeClock(speed);
const log = new SessionLog(sessionDir("replay", basename(file, ".json")));
const pipeline = new Pipeline({ playbook, classifier, clock, log });

const evals: Evaluation[] = [];
let failures = 0;
let lastDirection = "";
const out = (s: string) => {
  if (!values.quiet) console.log(s);
};

const mode = fast ? "fast" : speed === 1 ? "real time" : `${speed}x`;
console.log(`Replaying ${transcript.id} (${transcript.segments.length} segments) with ${classifier.name}, ${mode}`);
if (kind === "mock") console.log(styleText("yellow", "Mock classifier: noisy copies of the hand labels, for pipeline testing only."));

pipeline.on("segment", (s) => out(`${styleText("dim", clockLabel(s.end))} ${speakerLabel(s)} ${s.text}`));
pipeline.on("evaluation", (e) => {
  evals.push(e);
  out(formatEvaluation(e));
  if (!e.stale && e.state.direction !== lastDirection) {
    lastDirection = e.state.direction;
    out(formatDirection(e.state.direction));
  }
});
pipeline.on("failure", (f) => {
  failures++;
  out(styleText("red", `${" ".repeat(9)}#${f.seq} classifier error: ${String(f.error)}`));
});

const ac = new AbortController();
process.on("SIGINT", () => {
  ac.abort();
  pipeline.close();
});

if (fast) await replayFast(transcript, pipeline, clock as SteppedClock, ac.signal);
else await replayRealtime(transcript, pipeline, clock as RealtimeClock, ac.signal);

const callMs = (transcript.segments.at(-1)?.end ?? 0) * 1000;
printSummary(summarize(evals, failures, callMs), log.pipelinePath, { lagMeaningful: fast || speed === 1 });
