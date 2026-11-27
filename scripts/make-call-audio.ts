/**
 * Turns a typed transcript into a two-channel call recording with macOS voices, so the live
 * transcription path can be tested without placing a call. You on the left channel, Them on
 * the right, 16 kHz, the format the browser capture sends.
 *
 *   pnpm make-audio transcripts/sample-booked.json
 *
 * Writes transcripts/audio/<id>.wav and <id>.timing.json (where each line landed in the audio).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav, readWav } from "../src/audio/wav";
import { loadTranscript } from "../src/core/transcript";

const VOICES = { you: "Daniel", them: "Samantha" } as const;
const RATE = 16000;
const GAP_SAME_SPEAKER = 0.3;
const GAP_TURN = 0.6;

const file = process.argv[2];
if (!file) {
  console.error("Usage: pnpm make-audio <transcript.json>");
  process.exit(1);
}
const t = loadTranscript(file);
const work = mkdtempSync(join(tmpdir(), "coldcall-say-"));

const clips = t.segments.map((s, i) => {
  const aiff = join(work, `${i}.aiff`);
  const wav = join(work, `${i}.wav`);
  execFileSync("say", ["-v", VOICES[s.speaker], "-o", aiff, s.text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", aiff, wav]);
  const w = readWav(wav);
  return { seg: s, samples: new Int16Array(w.pcm.buffer, w.pcm.byteOffset, w.pcm.length / 2) };
});

// Lay the lines out one after another, with a short gap between them.
let cursor = 0.5;
const timing = clips.map((c, i) => {
  const prev = clips[i - 1];
  if (prev) cursor += prev.seg.speaker === c.seg.speaker ? GAP_SAME_SPEAKER : GAP_TURN;
  const start = cursor;
  cursor += c.samples.length / RATE;
  return { id: c.seg.id, speaker: c.seg.speaker, text: c.seg.text, start, end: cursor, label: c.seg.label ?? null };
});
const total = Math.ceil((cursor + 1.5) * RATE);
const out = new Int16Array(total * 2);
clips.forEach((c, i) => {
  const at = Math.round(timing[i]!.start * RATE);
  const ch = c.seg.speaker === "you" ? 0 : 1;
  for (let k = 0; k < c.samples.length; k++) out[(at + k) * 2 + ch] = c.samples[k]!;
});

mkdirSync("transcripts/audio", { recursive: true });
const wavPath = join("transcripts/audio", `${t.id}.wav`);
writeFileSync(wavPath, encodeWav({ sampleRate: RATE, channels: 2, pcm: Buffer.from(out.buffer) }));
writeFileSync(join("transcripts/audio", `${t.id}.timing.json`), JSON.stringify({ id: t.id, voices: VOICES, segments: timing }, null, 2));
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${wavPath} (${(total / RATE).toFixed(1)} s, You left, Them right)`);
