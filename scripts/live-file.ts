/**
 * Streams a two-channel call recording through the live path at real-time speed:
 * Deepgram (every word) -> sentence segmenter -> Jev -> state machine. Same code as a live call,
 * with a file instead of the browser.
 *
 *   pnpm live-file transcripts/audio/sample-booked.wav [--classifier jev|mock] [--window 16] [--endpointing 300] [--words]
 *
 * If <name>.timing.json sits next to the file (pnpm make-audio writes one), each sentence gets
 * the hand label of the line it came from, so agreement can be scored.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, styleText } from "node:util";
import { chunks, readWav } from "../src/audio/wav";
import { JevClassifier } from "../src/classifiers/jev";
import { OracleMockClassifier } from "../src/classifiers/mock";
import { clockLabel, formatDirection, formatEvaluation, ms, printSummary, speakerLabel } from "../src/cli/format";
import { LiveClock } from "../src/core/clock";
import { loadEnv } from "../src/core/env";
import { Pipeline, type Evaluation } from "../src/core/pipeline";
import { loadPlaybook } from "../src/core/playbook";
import { SessionLog, sessionDir } from "../src/core/sessionLog";
import { percentiles, summarize } from "../src/core/summary";
import type { Classifier, Segment, SegmentLabel } from "../src/core/types";
import { DeepgramTranscriber } from "../src/transcribe/deepgram";

loadEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    classifier: { type: "string" },
    words: { type: "boolean", default: false },
    window: { type: "string", default: "16" },
    endpointing: { type: "string", default: "300" },
  },
});
const file = positionals[0];
if (!file) {
  console.error("Usage: pnpm live-file <call.wav> [--classifier jev|mock] [--words]");
  process.exit(1);
}
const dgKey = process.env.DEEPGRAM_API_KEY;
if (!dgKey) {
  console.error("DEEPGRAM_API_KEY is not set. Add it to .env.");
  process.exit(1);
}

const wav = readWav(file);
if (wav.sampleRate !== 16000 || wav.channels !== 2) {
  console.error(`Expected 16 kHz two-channel audio, got ${wav.sampleRate} Hz with ${wav.channels} channels.`);
  process.exit(1);
}
const timingPath = file.replace(/\.wav$/, ".timing.json");
const timing: { speaker: string; start: number; end: number; label: SegmentLabel | null }[] = existsSync(timingPath)
  ? JSON.parse(readFileSync(timingPath, "utf8")).segments
  : [];

/** The hand label of the typed line this sentence overlaps most. */
function labelFor(seg: Segment): SegmentLabel | undefined {
  let best: (typeof timing)[number] | undefined;
  let bestOverlap = 0;
  for (const t of timing) {
    if (t.speaker !== seg.speaker) continue;
    const overlap = Math.min(t.end, seg.end) - Math.max(t.start, seg.start);
    if (overlap > bestOverlap) {
      best = t;
      bestOverlap = overlap;
    }
  }
  return best?.label ?? undefined;
}

const playbook = loadPlaybook();
const kind = values.classifier ?? (process.env.TYPESAFE_API_KEY ? "jev" : "mock");
const classifier: Classifier =
  kind === "jev"
    ? new JevClassifier(playbook, { apiKey: process.env.TYPESAFE_API_KEY!, model: process.env.JEV_MODEL || "jev-latest" })
    : new OracleMockClassifier(playbook);

const clock = new LiveClock();
const log = new SessionLog(sessionDir("audio", basename(file, ".wav")));
const pipeline = new Pipeline({ playbook, classifier, clock, log, windowSize: Number(values.window) });
const transcriber = new DeepgramTranscriber({ apiKey: dgKey, speakers: ["you", "them"], endpointingMs: Number(values.endpointing) });

const evals: Evaluation[] = [];
const transcriberDelays: number[] = [];
let failures = 0;
let revisions = 0;
let lastDirection = "";

transcriber.on("segment", (seg) => {
  const label = labelFor(seg);
  const segment = label ? { ...seg, label } : seg;
  const delay = clock.now() - seg.end * 1000;
  transcriberDelays.push(delay);
  console.log(`${styleText("dim", clockLabel(seg.end))} ${speakerLabel(seg)} ${seg.text}  ${styleText("dim", `(sentence out ${ms(delay)} after its last word)`)}`);
  void pipeline.pushFinal(segment);
});
transcriber.on("revise", (r) => {
  revisions++;
  console.log(styleText("dim", `${" ".repeat(9)}revised ${r.id}: ${r.text}`));
  pipeline.revise(r.id, r.text);
});
if (values.words) transcriber.on("live", (l) => l.text && console.log(styleText("dim", `${" ".repeat(9)}... ${l.speaker}: ${l.text}`)));
transcriber.on("error", (err) => console.error(styleText("red", `Deepgram: ${err.message}`)));

pipeline.on("evaluation", (e) => {
  evals.push(e);
  console.log(formatEvaluation(e));
  if (!e.stale && e.state.direction !== lastDirection) {
    lastDirection = e.state.direction;
    console.log(formatDirection(e.state.direction));
  }
});
pipeline.on("failure", (f) => {
  failures++;
  console.log(styleText("red", `${" ".repeat(9)}#${f.seq} classifier error: ${String(f.error)}`));
});

const seconds = wav.pcm.length / (wav.sampleRate * wav.channels * 2);
console.log(`Streaming ${basename(file)} (${seconds.toFixed(0)} s) through ${transcriber.name} and ${classifier.name}, real time, window ${values.window}, endpointing ${values.endpointing} ms`);
if (!timing.length) console.log(styleText("yellow", "No timing file next to the audio, so agreement cannot be scored."));

await transcriber.start();
const t0 = performance.now();
let sentMs = 0;
for (const chunk of chunks(wav, 100)) {
  clock.start();
  transcriber.write(chunk);
  sentMs += 100;
  const wait = t0 + sentMs - performance.now();
  if (wait > 0) await sleep(wait);
}
await transcriber.stop();
await pipeline.drain();

const td = percentiles(transcriberDelays);
printSummary(summarize(evals, failures, seconds * 1000), log.pipelinePath, {
  lagMeaningful: true,
  extra: [
    `  Sentences         ${transcriberDelays.length}, ${revisions} revised after sending`,
    `  Transcriber part  ${td ? `p50 ${ms(td.p50)}, p90 ${ms(td.p90)} from last word to sentence out` : "n/a"}`,
  ],
});
