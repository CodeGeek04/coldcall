/**
 * Milestone 1: Jev smoke test.
 * Sends one hard-coded transcript window with the block, stance and readiness questions,
 * prints the exact request and raw response, checks the response against the schema we
 * rely on, then runs a few labeled probes and a short latency sample.
 *
 *   pnpm smoke            (needs TYPESAFE_API_KEY in .env)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { buildJevRequest, JEV_ENDPOINT, JevClassifier, JevResponseSchema } from "../src/classifiers/jev";
import { loadEnv } from "../src/core/env";
import { loadPlaybook } from "../src/core/playbook";
import { SessionLog, sessionDir } from "../src/core/sessionLog";
import { ranked } from "../src/core/stateMachine";
import { percentiles } from "../src/core/summary";
import type { Segment } from "../src/core/types";

loadEnv();
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}
const model = process.env.JEV_MODEL || "jev-latest";
const playbook = loadPlaybook();
const outDir = sessionDir("smoke", model);
new SessionLog(outDir); // creates the folder
const report: Record<string, unknown> = { model, endpoint: JEV_ENDPOINT, at: new Date().toISOString() };

let n = 0;
const seg = (speaker: "you" | "them", text: string): Segment => ({ id: `s${++n}`, speaker, text, start: n, end: n });

// 1. Models available to this key.
section("GET /v1/models");
try {
  const res = await fetch("https://api.typesafe.ai/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body.slice(0, 2000));
  report.models = { status: res.status, body: tryJson(body) };
} catch (err) {
  console.log(styleText("red", `failed: ${String(err)}`));
}

// 2. One hard-coded window, raw request and raw response.
const window: Segment[] = [
  seg("them", "This is Dr. Patel."),
  seg("you", "Hi Dr. Patel, Sam from Brightline. We help dental practices cut no-shows, and I'm calling because you opened a second location this year."),
  seg("you", "Could I have thirty seconds to explain why I called, and you tell me if it's relevant?"),
  seg("them", "Honestly, I'm between patients, and we already have a reminder system."),
];
const body = buildJevRequest(playbook, window, "hook", model);
section("POST /v1/systemone: request body");
console.log(JSON.stringify(body, null, 2));

section("POST /v1/systemone: raw response");
const started = performance.now();
const res = await fetch(JEV_ENDPOINT, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const latencyMs = performance.now() - started;
const text = await res.text();
console.log(`HTTP ${res.status} in ${Math.round(latencyMs)} ms`);
console.log(JSON.stringify(tryJson(text), null, 2));
report.request = body;
report.response = { status: res.status, latencyMs, body: tryJson(text), headers: Object.fromEntries(res.headers) };

if (!res.ok) {
  save();
  console.error(styleText("red", "\nRequest failed. The response above says why; the full record is saved."));
  process.exit(1);
}

section("Schema check");
const parsed = JevResponseSchema.safeParse(tryJson(text));
if (parsed.success) {
  const a = parsed.data.answers;
  console.log(styleText("green", "Response matches the schema the pipeline relies on."));
  console.log(`model ${parsed.data.model}, input tokens ${parsed.data.usage.input_tokens}, output tokens ${parsed.data.usage.output_tokens}`);
  console.log(`block     ${fmtProbs(a.block.probabilities)}  (confidence ${a.block.confidence.toFixed(2)})`);
  console.log(`stance    ${fmtProbs(a.stance.probabilities)}  (confidence ${a.stance.confidence.toFixed(2)})`);
  console.log(`readiness score ${a.readiness.score.toFixed(2)} of ${playbook.readiness.length - 1}  (confidence ${a.readiness.confidence.toFixed(2)})`);
} else {
  console.log(styleText("red", "Response does NOT match the expected schema. Fix src/classifiers/jev.ts before going on:"));
  console.log(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
}
report.schemaOk = parsed.success;

// 3. Labeled probes through the classifier itself.
section("Probes (expected block / stance)");
const jev = new JevClassifier(playbook, { apiKey, model, timeoutMs: 10_000 });
const probes: { name: string; current: string | null; want: [string, string]; window: Segment[] }[] = [
  {
    name: "gatekeeper",
    current: null,
    want: ["gatekeeper", "neutral"],
    window: [seg("them", "Good morning, Cedar Dental, this is Maria speaking."), seg("you", "Hi Maria, this is Sam from Brightline. Could I speak with Dr. Patel, please?"), seg("them", "Can I ask what this is regarding?")],
  },
  {
    name: "discovery",
    current: "reluctant",
    want: ["discovery", "open"],
    window: [seg("you", "Out of curiosity, are no-shows still a problem with them?"), seg("them", "I mean, a bit. The texts go out, but people still don't show up, especially on Mondays."), seg("you", "How many would you say you lose on a typical Monday?"), seg("them", "Maybe three or four slots at the new location. The front desk ends up calling the waitlist by hand.")],
  },
  {
    name: "ask",
    current: "pitch",
    want: ["ask", "ready"],
    window: [seg("them", "Okay. What does it cost?"), seg("you", "It depends on the number of chairs. Easiest is a fifteen-minute call where I show it on your schedule. Would Thursday at 12:30 or Friday at 8 work?"), seg("them", "Friday morning is tough. Thursday lunchtime could work.")],
  },
  {
    name: "hostile",
    current: "hook",
    want: ["reluctant", "hostile"],
    window: [seg("you", "I'll be quick: could I have thirty seconds to explain why I called?"), seg("them", "No. I get five of these calls a day. We're not interested, take me off your list.")],
  },
];
const probeResults = [];
for (const p of probes) {
  try {
    const r = await jev.classify({ seq: 0, window: p.window, currentBlock: p.current });
    const b = ranked(r.block)[0]!;
    const s = ranked(r.stance)[0]!;
    const ok = (want: string, got: string) => (want === got ? styleText("green", got) : styleText("red", got));
    console.log(
      `${p.name.padEnd(11)} block ${ok(p.want[0], b.id)} ${pctStr(b.p)}  stance ${ok(p.want[1], s.id)} ${pctStr(s.p)}  ready ${r.readiness.toFixed(2)}  ${Math.round(r.latencyMs)} ms  ${r.inputTokens} tok`,
    );
    probeResults.push({ ...p, result: r });
  } catch (err) {
    console.log(styleText("red", `${p.name}: ${String(err)}`));
    probeResults.push({ ...p, error: String(err) });
  }
}
report.probes = probeResults;

// 4. Latency sample: the same request, sequentially.
section("Latency (8 sequential requests)");
const times: number[] = [];
for (let i = 0; i < 8; i++) {
  try {
    const r = await jev.classify({ seq: i, window, currentBlock: "hook" });
    times.push(r.latencyMs);
  } catch (err) {
    console.log(styleText("red", String(err)));
  }
}
const lat = percentiles(times);
if (lat) console.log(`p50 ${Math.round(lat.p50)} ms, p90 ${Math.round(lat.p90)} ms, max ${Math.round(lat.max)} ms (wall time from this machine)`);
report.latencyMs = { samples: times, ...lat };

save();

function save() {
  const path = join(outDir, "smoke.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nSaved ${path}`);
}

function section(title: string) {
  console.log(`\n${styleText("bold", `== ${title}`)}`);
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function fmtProbs(p: Record<string, number>): string {
  return ranked(p)
    .slice(0, 4)
    .map((e) => `${e.id} ${pctStr(e.p)}`)
    .join(", ");
}

function pctStr(p: number): string {
  return `${Math.round(p * 100)}%`;
}
