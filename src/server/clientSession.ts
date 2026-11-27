import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chunks, readWav, wavInfo, WavWriter } from "../audio/wav";
import { JevClassifier } from "../classifiers/jev";
import { OracleMockClassifier } from "../classifiers/mock";
import { LiveClock, RealtimeClock } from "../core/clock";
import { Pipeline, type Evaluation } from "../core/pipeline";
import type { Playbook } from "../core/playbook";
import { SessionLog, sessionDir } from "../core/sessionLog";
import { summarize } from "../core/summary";
import { loadTranscript } from "../core/transcript";
import type { Classifier, Segment, SegmentLabel } from "../core/types";
import { replayRealtime } from "../replay/driver";
import {
  ClientMsgSchema,
  type AudioInfo,
  type ClassifierKind,
  type PlaybookView,
  type RunMode,
  type ServerMsg,
  type TranscriptInfo,
} from "../shared/protocol";
import { DeepgramTranscriber } from "../transcribe/deepgram";

export const TRANSCRIPTS_DIR = "transcripts";
export const AUDIO_DIR = join(TRANSCRIPTS_DIR, "audio");
export const SESSIONS_DIR = "sessions";
/** Sentences are shorter than typed lines, so live runs keep more of them (about a minute). */
export const LIVE_WINDOW = 16;

export function playbookView(pb: Playbook): PlaybookView {
  return {
    blocks: pb.blocks.map((b, i) => ({ id: b.id, describe: b.describe, key: i < 9 ? i + 1 : null })),
    stances: pb.stances.map((s) => ({ id: s.id, describe: s.describe })),
    unknownDirection: pb.unknown_direction,
  };
}

export function listTranscripts(dir = TRANSCRIPTS_DIR): TranscriptInfo[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      try {
        const t = loadTranscript(join(dir, file));
        return [{ file, id: t.id, description: t.description, segments: t.segments.length, seconds: t.segments.at(-1)?.end ?? 0 }];
      } catch {
        return [];
      }
    });
}

export interface AudioEntry extends AudioInfo {
  path: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20261117-140657-live-call" -> "Call on 17 Nov, 14:06" */
function savedCallName(dir: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(dir);
  if (!m) return dir;
  return `Call on ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}, ${m[4]}:${m[5]}`;
}

function usable(path: string): number | null {
  try {
    const info = wavInfo(path);
    // Skips the call being recorded right now (its header says 0 s until it ends).
    return info.sampleRate === 16000 && info.channels === 2 && info.seconds >= 1 ? info.seconds : null;
  } catch {
    return null;
  }
}

/**
 * Two-channel 16 kHz recordings: live calls saved with Save audio (newest first), then the
 * generated samples (pnpm make-audio).
 */
export function listAudio(): AudioEntry[] {
  const saved: AudioEntry[] = existsSync(SESSIONS_DIR)
    ? readdirSync(SESSIONS_DIR)
        .filter((d) => d.includes("-live-") && existsSync(join(SESSIONS_DIR, d, "audio.wav")))
        .sort()
        .reverse()
        .flatMap((d) => {
          const path = join(SESSIONS_DIR, d, "audio.wav");
          const seconds = usable(path);
          return seconds === null ? [] : [{ file: `${d}.wav`, id: savedCallName(d), seconds, kind: "saved" as const, path }];
        })
    : [];
  const samples: AudioEntry[] = existsSync(AUDIO_DIR)
    ? readdirSync(AUDIO_DIR)
        .filter((f) => f.endsWith(".wav"))
        .sort()
        .flatMap((file) => {
          const path = join(AUDIO_DIR, file);
          const seconds = usable(path);
          return seconds === null ? [] : [{ file, id: basename(file, ".wav"), seconds, kind: "sample" as const, path }];
        })
    : [];
  return [...saved, ...samples];
}

/** The list the browser sees: no file paths. */
export function audioInfos(): AudioInfo[] {
  return listAudio().map(({ path: _path, ...info }) => info);
}

interface Socket {
  readonly readyState: number;
  send(data: string): void;
  on(event: "message", cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", cb: () => void): void;
}

export interface SessionEnv {
  typesafeKey?: string;
  jevModel?: string;
  deepgramKey?: string;
}

interface ActiveRun {
  runId: number;
  pipeline: Pipeline;
  /** Ends the run: flushes the transcriber, waits for results in flight. */
  end(): Promise<void>;
  write?(pcm: Buffer): void;
  evals: Evaluation[];
  failures: number;
  callMs(): number;
  log: SessionLog;
  /** Where Save audio is writing, if on. */
  audioPath: string | null;
  abort: AbortController;
  ticker: NodeJS.Timeout;
}

/** One browser tab. Runs one call at a time (typed, recorded or live) and streams its screen state. */
export class ClientSession {
  private runId = 0;
  private active: ActiveRun | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly playbook: Playbook,
    private readonly env: SessionEnv,
  ) {
    socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    socket.on("close", () => void this.finish("stopped"));
    this.send({
      type: "hello",
      playbook: playbookView(playbook),
      transcripts: listTranscripts(),
      audioFiles: audioInfos(),
      classifiers: env.typesafeKey ? ["jev", "mock"] : ["mock"],
      canTranscribe: Boolean(env.deepgramKey),
    });
  }

  private send(msg: ServerMsg): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(msg));
  }

  private error(message: string): void {
    this.send({ type: "error", message });
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.active?.write?.(data);
      return;
    }
    let parsed;
    try {
      parsed = ClientMsgSchema.safeParse(JSON.parse(data.toString()));
    } catch {
      return this.error("Message was not valid JSON.");
    }
    if (!parsed.success) return this.error(`Unrecognized message: ${parsed.error.message}`);
    const msg = parsed.data;

    switch (msg.type) {
      case "start":
        return void this.startTyped(msg.transcript, msg.classifier, msg.speed);
      case "play-audio":
        return void this.startTranscribed("recorded", msg.classifier, { file: msg.file });
      case "listen":
        return void this.startTranscribed("live", msg.classifier, { record: msg.record });
      case "stop":
        return void this.finish("stopped");
      case "override":
        if (!this.active) return this.error("Start a call before pinning a block.");
        if (!this.playbook.blocks.some((b) => b.id === msg.block)) return this.error(`"${msg.block}" is not a block in playbook.yaml.`);
        this.active.pipeline.override(msg.block);
    }
  }

  private classifier(kind: ClassifierKind): Classifier | null {
    if (kind === "mock") return new OracleMockClassifier(this.playbook);
    if (!this.env.typesafeKey) {
      this.error("TYPESAFE_API_KEY is not set, so only the mock classifier is available.");
      return null;
    }
    return new JevClassifier(this.playbook, { apiKey: this.env.typesafeKey, model: this.env.jevModel || "jev-latest" });
  }

  /** Common wiring: pipeline events to the browser, plus a ticker so pins can expire. */
  private beginRun(pipeline: Pipeline, log: SessionLog, callMs: () => number, end: () => Promise<void>, audioPath: string | null = null): ActiveRun {
    const runId = ++this.runId;
    const run: ActiveRun = {
      runId,
      pipeline,
      end,
      evals: [],
      failures: 0,
      callMs,
      log,
      audioPath,
      abort: new AbortController(),
      ticker: setInterval(() => pipeline.tick(), 200),
    };
    pipeline.on("segment", (segment) => this.send({ type: "segment", runId, segment }));
    pipeline.on("revision", (r) => this.send({ type: "revision", runId, id: r.id, text: r.text }));
    pipeline.on("state", (state) => this.send({ type: "state", runId, state }));
    pipeline.on("evaluation", (e) => {
      run.evals.push(e);
      this.send({ type: "evaluation", runId, seq: e.seq, stale: e.stale, lagMs: e.lagMs, latencyMs: e.result.latencyMs, top: e.state.top });
    });
    pipeline.on("failure", (f) => {
      run.failures++;
      this.send({ type: "failure", runId, seq: f.seq, message: String(f.error) });
    });
    this.active = run;
    return run;
  }

  private async startTyped(file: string, kind: ClassifierKind, speed: number): Promise<void> {
    await this.finish("stopped");
    // Only files the server listed: no paths from the client.
    if (basename(file) !== file || !listTranscripts().some((t) => t.file === file)) {
      return this.error(`Transcript "${file}" was not found in ${TRANSCRIPTS_DIR}/.`);
    }
    const classifier = this.classifier(kind);
    if (!classifier) return;

    const transcript = loadTranscript(join(TRANSCRIPTS_DIR, file));
    const clock = new RealtimeClock(speed);
    const log = new SessionLog(sessionDir("replay", transcript.id));
    const pipeline = new Pipeline({ playbook: this.playbook, classifier, clock, log });
    const seconds = transcript.segments.at(-1)?.end ?? 0;
    const run = this.beginRun(pipeline, log, () => seconds * 1000, () => pipeline.drain());
    this.send({ type: "run", status: "started", runId: run.runId, mode: "typed", name: transcript.id, classifier: classifier.name, speed, seconds, audioUrl: null });
    this.send({ type: "state", runId: run.runId, state: pipeline.state });

    await replayRealtime(transcript, pipeline, clock, run.abort.signal);
    if (!run.abort.signal.aborted) await this.finish("finished", run.runId);
  }

  private async startTranscribed(mode: Exclude<RunMode, "typed">, kind: ClassifierKind, opts: { file?: string; record?: boolean }): Promise<void> {
    await this.finish("stopped");
    if (!this.env.deepgramKey) return this.error("DEEPGRAM_API_KEY is not set, so recorded and live calls are off.");
    let audio: { entry: AudioEntry; labels: TimingLine[] } | null = null;
    if (mode === "recorded") {
      // Only recordings the server listed: no paths from the client.
      const entry = listAudio().find((a) => a.file === opts.file);
      if (!entry) return this.error(`Recording "${opts.file ?? ""}" was not found. Reload the page to refresh the list.`);
      audio = { entry, labels: loadTiming(entry.path) };
    }
    const classifier = this.classifier(kind);
    if (!classifier) return;

    const name = audio ? basename(audio.entry.file, ".wav") : "call";
    const clock = new LiveClock();
    const log = new SessionLog(sessionDir(mode, name));
    const pipeline = new Pipeline({ playbook: this.playbook, classifier, clock, log, windowSize: LIVE_WINDOW });
    const transcriber = new DeepgramTranscriber({ apiKey: this.env.deepgramKey, speakers: ["you", "them"] });
    const audioPath = opts.record ? join(log.dir, "audio.wav") : null;
    const recorder = audioPath ? new WavWriter(audioPath, 16000, 2) : null;

    const run = this.beginRun(pipeline, log, () => clock.now(), async () => {
      await transcriber.stop();
      await pipeline.drain();
      recorder?.close();
    }, audioPath);
    const runId = run.runId;
    transcriber.on("segment", (seg) => {
      const label = audio ? labelFor(seg, audio.labels) : undefined;
      void pipeline.pushFinal(label ? { ...seg, label } : seg);
    });
    transcriber.on("revise", (r) => pipeline.revise(r.id, r.text));
    transcriber.on("live", (l) => this.send({ type: "words", runId, speaker: l.speaker, text: l.text }));
    transcriber.on("error", (err) => this.error(`Transcriber: ${err.message}`));
    transcriber.on("close", ({ code, reason }) => {
      if (this.active?.runId === runId && code !== 1000) {
        this.error(`The transcriber closed the stream (${code}${reason ? `: ${reason}` : ""}). Stop and start again.`);
      }
    });

    try {
      await transcriber.start();
    } catch (err) {
      this.error(String(err instanceof Error ? err.message : err));
      return this.finish("stopped", runId);
    }
    if (this.active?.runId !== runId) return;

    run.write = (pcm) => {
      clock.start();
      transcriber.write(pcm);
      recorder?.write(pcm);
    };
    const seconds = audio ? audio.entry.seconds : null;
    this.send({
      type: "run",
      status: "started",
      runId,
      mode,
      name,
      classifier: classifier.name,
      speed: 1,
      seconds,
      audioUrl: audio ? `/api/audio/${encodeURIComponent(audio.entry.file)}` : null,
    });
    this.send({ type: "state", runId, state: pipeline.state });

    if (audio) {
      // Feed the file at real-time speed, as if it were arriving from the browser.
      const wav = readWav(audio.entry.path);
      const t0 = performance.now();
      let sentMs = 0;
      for (const chunk of chunks(wav, 100)) {
        if (run.abort.signal.aborted) return;
        run.write(chunk);
        sentMs += 100;
        const wait = t0 + sentMs - performance.now();
        if (wait > 0) await sleep(wait);
      }
      await this.finish("finished", runId);
    }
  }

  /** Ends the active run (or the given one, if still active) and reports its summary. */
  private async finish(status: "finished" | "stopped", runId?: number): Promise<void> {
    const run = this.active;
    if (!run || (runId !== undefined && run.runId !== runId)) return;
    this.active = null;
    run.abort.abort();
    clearInterval(run.ticker);
    await run.end();
    run.pipeline.close();
    const summary = run.evals.length ? summarize(run.evals, run.failures, run.callMs()) : null;
    this.send({ type: "run", status, runId: run.runId, summary, logPath: run.log.pipelinePath, audioPath: run.audioPath });
    if (run.audioPath) this.send({ type: "audio-files", audioFiles: audioInfos() });
  }
}

interface TimingLine {
  speaker: string;
  start: number;
  end: number;
  label: SegmentLabel | null;
}

function loadTiming(wavPath: string): TimingLine[] {
  const path = wavPath.replace(/\.wav$/, ".timing.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")).segments as TimingLine[];
  } catch {
    return [];
  }
}

/** The hand label of the typed line a transcribed sentence overlaps most. */
export function labelFor(seg: Segment, lines: TimingLine[]): SegmentLabel | undefined {
  let best: TimingLine | undefined;
  let bestOverlap = 0;
  for (const t of lines) {
    if (t.speaker !== seg.speaker) continue;
    const overlap = Math.min(t.end, seg.end) - Math.max(t.start, seg.start);
    if (overlap > bestOverlap) {
      best = t;
      bestOverlap = overlap;
    }
  }
  return best?.label ?? undefined;
}

