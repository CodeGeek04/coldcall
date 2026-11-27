import { useEffect, useState, type CSSProperties } from "react";
import { defaultHearOn, defaultSources, type ThemSource } from "../audio/capture";
import type { ClassifierKind, ClientMsg, RunMode } from "../../../src/shared/protocol";
import { captureErrorMessage, type useLive } from "../useLive";
import type { Run, SessionState } from "../useSession";

interface Props {
  state: SessionState;
  send: (msg: ClientMsg) => void;
  notify: (text: string | null) => void;
  live: ReturnType<typeof useLive>;
}

const MODES: { id: RunMode; name: string }[] = [
  { id: "live", name: "Live call" },
  { id: "recorded", name: "Recorded call" },
  { id: "typed", name: "Typed call" },
];
const SPEEDS = [1, 2, 4];
const CLASSIFIER_NAMES: Record<ClassifierKind, string> = { jev: "Jev", mock: "Mock (offline)" };
const TAB = "tab";
const NONE = "none";

function remembered<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the choice just is not remembered.
  }
}

export function ControlBar({ state, send, notify, live }: Props) {
  const { run, connected, transcripts, audioFiles, classifiers, canTranscribe } = state;
  const running = run?.status === "running" || live.capturing;
  const [mode, setMode] = useState<RunMode>(() => remembered("mode", "typed"));
  const [transcript, setTranscript] = useState("");
  const [audioFile, setAudioFile] = useState("");
  const [classifier, setClassifier] = useState<ClassifierKind>("mock");
  const [speed, setSpeed] = useState(1);
  const [you, setYou] = useState("");
  const [them, setThem] = useState("");
  const [record, setRecordState] = useState(() => remembered("save-audio", "on") === "on");
  const setRecord = (on: boolean) => {
    setRecordState(on);
    remember("save-audio", on ? "on" : "off");
  };
  /** Output to play the other side on: a device id, NONE, or "" until a safe default is known. */
  const [hearOn, setHearOn] = useState("");

  useEffect(() => {
    if (!transcript && transcripts[0]) setTranscript(transcripts[0].file);
  }, [transcripts, transcript]);
  useEffect(() => {
    if (audioFiles[0] && !audioFiles.some((a) => a.file === audioFile)) setAudioFile(audioFiles[0].file);
  }, [audioFiles, audioFile]);
  useEffect(() => {
    if (classifiers.includes("jev")) setClassifier("jev");
  }, [classifiers]);

  // Device names need microphone permission, so only ask once live mode is chosen.
  const { loadInputs, silentOutput } = live;
  useEffect(() => {
    if (mode === "live" && silentOutput) {
      notify(`Your Mac's sound output is ${silentOutput}, so you will not hear anything. Switch it to your speakers or headphones in Control Center; only the call app should send to BlackHole.`);
    }
  }, [mode, silentOutput, notify]);
  useEffect(() => {
    if (mode !== "live") return;
    loadInputs()
      .then((list) => {
        const d = defaultSources(list);
        if (!d) return notify("No microphone found. Connect one, then reload.");
        setYou((v) => v || d.youDeviceId);
        setThem((v) => v || (d.them.kind === "device" ? d.them.deviceId : TAB));
      })
      .catch((err: unknown) => notify(captureErrorMessage(err)));
  }, [mode, loadInputs, notify]);

  // With BlackHole as the other side, the call app is silent to you unless this page plays it.
  // Default to the Mac's current output when it is safe (listOutputs drops loopbacks), else the first safe one.
  const { outputs } = live;
  useEffect(() => {
    if (hearOn === NONE || outputs.some((d) => d.deviceId === hearOn)) return;
    setHearOn(defaultHearOn(outputs));
  }, [outputs, hearOn]);

  const pickMode = (m: RunMode) => {
    setMode(m);
    remember("mode", m);
  };

  const startLive = async () => {
    notify(null);
    const themSource: ThemSource = them === TAB ? { kind: "tab" } : { kind: "device", deviceId: them };
    try {
      const hearThemOn = them === TAB || hearOn === NONE || !hearOn ? null : hearOn;
      await live.start({ youDeviceId: you, them: themSource, hearThemOn });
      send({ type: "listen", classifier, record });
    } catch (err) {
      live.stop();
      notify(captureErrorMessage(err));
    }
  };

  const stopRun = () => {
    send({ type: "stop" });
    live.stop();
  };

  const mics = live.inputs.filter((d) => !/blackhole/i.test(d.label));
  const needsTranscriber = mode !== "typed" && !canTranscribe;

  return (
    <header className="bar">
      <label>
        <span className="visually-hidden">Mode</span>
        <select value={mode} onChange={(e) => pickMode(e.target.value as RunMode)} disabled={running}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {mode === "typed" && (
        <>
          <Select label="Transcript" value={transcript} onChange={setTranscript} disabled={running}>
            {transcripts.map((t) => (
              <option key={t.file} value={t.file}>
                {t.id} ({formatClock(t.seconds)})
              </option>
            ))}
          </Select>
          <Select label="Speed" value={String(speed)} onChange={(v) => setSpeed(Number(v))} disabled={running}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s === 1 ? "Real time" : `${s}x speed`}
              </option>
            ))}
          </Select>
        </>
      )}

      {mode === "recorded" && (
        <Select label="Recording" value={audioFile} onChange={setAudioFile} disabled={running}>
          {audioFiles.length === 0 && <option value="">No recordings yet</option>}
          {(["saved", "sample"] as const).map((kind) => {
            const list = audioFiles.filter((a) => a.kind === kind);
            if (!list.length) return null;
            return (
              <optgroup key={kind} label={kind === "saved" ? "Your calls" : "Samples"}>
                {list.map((a) => (
                  <option key={a.file} value={a.file}>
                    {a.id} ({formatClock(a.seconds)})
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      )}

      {mode === "live" && (
        <>
          <Select label="Your microphone" value={you} onChange={setYou} disabled={running}>
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                You: {d.label || "Microphone"}
              </option>
            ))}
          </Select>
          <Select label="The other side" value={them} onChange={setThem} disabled={running}>
            {live.inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                Them: {d.label || "Input"}
              </option>
            ))}
            <option value={TAB}>Them: a Chrome tab (Meet, Zoom web)</option>
          </Select>
          {them !== TAB && (
            <Select label="Hear the other side on" value={hearOn} onChange={setHearOn} disabled={running}>
              <option value={NONE}>Don't play them here</option>
              {live.outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  Hear them on: {d.deviceId === "default" ? d.label.replace(/^Default - /, "") + " (current)" : d.label || "Output"}
                </option>
              ))}
            </Select>
          )}
          <span className="levels" aria-label="Input levels">
            <Level name="You" value={live.levels[0]} />
            <Level name="Them" value={live.levels[1]} />
          </span>
          <label className="check">
            <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} disabled={running} />
            Save audio
          </label>
        </>
      )}

      <Select label="Classifier" value={classifier} onChange={(v) => setClassifier(v as ClassifierKind)} disabled={running}>
        {classifiers.map((c) => (
          <option key={c} value={c}>
            {CLASSIFIER_NAMES[c]}
          </option>
        ))}
      </Select>

      {running ? (
        <button type="button" className="button" onClick={stopRun}>
          {mode === "live" ? "End call" : "Stop"}
        </button>
      ) : (
        <button
          type="button"
          className="button primary"
          disabled={!connected || needsTranscriber || (mode === "typed" && !transcript) || (mode === "recorded" && !audioFile) || (mode === "live" && !you)}
          title={needsTranscriber ? "Add DEEPGRAM_API_KEY to .env to transcribe audio." : undefined}
          onClick={() => {
            notify(null);
            if (mode === "typed") send({ type: "start", transcript, classifier, speed });
            else if (mode === "recorded") send({ type: "play-audio", file: audioFile, classifier });
            else void startLive();
          }}
        >
          {mode === "live" ? "Start listening" : mode === "recorded" ? "Play recording" : "Start replay"}
        </button>
      )}

      <span className="bar-end">
        {run && <CallClock run={run} />}
        <span className="conn" data-ok={connected}>
          {connected ? "Connected" : "Reconnecting to the server"}
        </span>
      </span>
    </header>
  );
}

function Select(props: { label: string; value: string; onChange: (v: string) => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <label>
      <span className="visually-hidden">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} disabled={props.disabled}>
        {props.children}
      </select>
    </label>
  );
}

/** Peak level, shown on a square-root scale so speech reads clearly. */
function Level({ name, value }: { name: string; value: number }) {
  return (
    <span className="level">
      <span className="level-name">{name}</span>
      <span className="level-bar">
        <span style={{ "--v": Math.min(1, Math.sqrt(value)) } as CSSProperties} />
      </span>
    </span>
  );
}

function CallClock({ run }: { run: Run }) {
  const [now, setNow] = useState(() => performance.now());
  const running = run.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(t);
  }, [running]);
  const elapsed = ((now - run.startedAt) / 1000) * run.speed;
  return <span className="clock">{formatClock(run.seconds === null ? elapsed : Math.min(run.seconds, elapsed))}</span>;
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
