import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Summary } from "../../src/core/summary";
import type { DisplayState, ProbEntry, Segment, Speaker } from "../../src/core/types";
import type { AudioInfo, ClassifierKind, ClientMsg, PlaybookView, RunMode, ServerMsg, TranscriptInfo } from "../../src/shared/protocol";

export interface Run {
  id: number;
  mode: RunMode;
  name: string;
  classifier: string;
  speed: number;
  /** Null for a live call. */
  seconds: number | null;
  audioUrl: string | null;
  /** performance.now() when the run started, for the call clock. */
  startedAt: number;
  status: "running" | "finished" | "stopped";
  summary: Summary | null;
  logPath: string | null;
  /** Where Save audio wrote the call, once it has ended. */
  audioPath: string | null;
}

export interface LastResult {
  seq: number;
  lagMs: number;
  latencyMs: number;
  top: ProbEntry | null;
}

export interface SessionState {
  connected: boolean;
  playbook: PlaybookView | null;
  transcripts: TranscriptInfo[];
  audioFiles: AudioInfo[];
  classifiers: ClassifierKind[];
  canTranscribe: boolean;
  run: Run | null;
  display: DisplayState | null;
  segments: Segment[];
  /** Words heard but not yet in a sentence, per speaker. */
  words: Record<Speaker, string>;
  last: LastResult | null;
  notice: string | null;
}

type Action = { type: "connected"; value: boolean } | { type: "msg"; msg: ServerMsg } | { type: "notice"; text: string | null };

const NO_WORDS: Record<Speaker, string> = { you: "", them: "" };

const initial: SessionState = {
  connected: false,
  playbook: null,
  transcripts: [],
  audioFiles: [],
  classifiers: [],
  canTranscribe: false,
  run: null,
  display: null,
  segments: [],
  words: NO_WORDS,
  last: null,
  notice: null,
};

function reducer(s: SessionState, a: Action): SessionState {
  if (a.type === "connected") return { ...s, connected: a.value };
  if (a.type === "notice") return { ...s, notice: a.text };
  const m = a.msg;
  // Ignore anything from a run that is no longer the current one.
  if ("runId" in m && m.type !== "run" && m.runId !== s.run?.id) return s;

  switch (m.type) {
    case "hello":
      return { ...s, playbook: m.playbook, transcripts: m.transcripts, audioFiles: m.audioFiles, classifiers: m.classifiers, canTranscribe: m.canTranscribe };
    case "run":
      if (m.status === "started") {
        return {
          ...s,
          run: {
            id: m.runId,
            mode: m.mode,
            name: m.name,
            classifier: m.classifier,
            speed: m.speed,
            seconds: m.seconds,
            audioUrl: m.audioUrl,
            startedAt: performance.now(),
            status: "running",
            summary: null,
            logPath: null,
            audioPath: null,
          },
          display: null,
          segments: [],
          words: NO_WORDS,
          last: null,
          notice: null,
        };
      }
      if (m.runId !== s.run?.id) return s;
      return { ...s, run: { ...s.run, status: m.status, summary: m.summary, logPath: m.logPath, audioPath: m.audioPath }, words: NO_WORDS };
    case "audio-files":
      return { ...s, audioFiles: m.audioFiles };
    case "segment":
      return { ...s, segments: [...s.segments, m.segment].slice(-80) };
    case "revision":
      return { ...s, segments: s.segments.map((seg) => (seg.id === m.id ? { ...seg, text: m.text } : seg)) };
    case "words":
      return { ...s, words: { ...s.words, [m.speaker]: m.text } };
    case "state":
      return { ...s, display: m.state };
    case "evaluation":
      return m.stale ? s : { ...s, last: { seq: m.seq, lagMs: m.lagMs, latencyMs: m.latencyMs, top: m.top } };
    case "failure":
      return { ...s, notice: `Result ${m.seq} failed: ${m.message}. The screen keeps the last result.` };
    case "error":
      return { ...s, notice: m.message };
  }
}

/** One WebSocket to the server, reconnecting every second while it is down. */
export function useSession() {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => dispatch({ type: "connected", value: true });
      ws.onclose = () => {
        dispatch({ type: "connected", value: false });
        if (!closed) retry = window.setTimeout(connect, 1000);
      };
      ws.onmessage = (ev) => dispatch({ type: "msg", msg: JSON.parse(String(ev.data)) as ServerMsg });
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendAudio = useCallback((pcm: ArrayBuffer) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
  }, []);

  const notify = useCallback((text: string | null) => dispatch({ type: "notice", text }), []);

  return { state, send, sendAudio, notify };
}
