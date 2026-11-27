import { useEffect, useRef, useState } from "react";
import { pct } from "../../src/core/summary";
import { ControlBar } from "./components/ControlBar";
import { StanceSignal } from "./components/StanceSignal";
import { titleCase, TrackMap } from "./components/TrackMap";
import { TranscriptPane } from "./components/TranscriptPane";
import { useLive } from "./useLive";
import { useSession, type SessionState } from "./useSession";

export function App() {
  const { state, send, sendAudio, notify } = useSession();
  const live = useLive(state.run, state.notice, sendAudio);
  const [showTranscript, setShowTranscript] = useState(true);
  const { playbook, display, run } = state;
  const running = run?.status === "running";
  usePlayback(run);

  // 1 to 9 pin a block (manual override); T shows or hides the transcript.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "t" || e.key === "T") {
        setShowTranscript((v) => !v);
        return;
      }
      const block = playbook?.blocks.find((b) => b.key !== null && String(b.key) === e.key);
      if (block && running) send({ type: "override", block: block.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playbook, running, send]);

  const direction = !run ? null : (display?.direction ?? playbook?.unknownDirection ?? "");
  const next = display?.next ?? null;
  const unknown = (display?.unknown ?? true) && !next;

  return (
    <div className="app" data-transcript={showTranscript}>
      <ControlBar state={state} send={send} notify={notify} live={live} />

      <main className="hud">
        {playbook ? (
          <TrackMap blocks={playbook.blocks} display={display} onPin={(block) => running && send({ type: "override", block })} />
        ) : (
          <p className="waiting">{state.connected ? "Loading the playbook." : "Waiting for the server. Start it with pnpm dev."}</p>
        )}

        <div className="readout">
          <div className="advice" aria-live="polite">
            {next && (
              <p className="next-reason">
                Next: {titleCase(next.block)}, because {next.because}
              </p>
            )}
            <p className="direction" data-unknown={unknown}>
              {direction === null ? <span className="direction-empty">Start a call to drive the screen.</span> : direction || <span className="direction-empty">No direction written for this block yet.</span>}
            </p>
          </div>
          <StanceSignal display={display} />
        </div>
      </main>

      {showTranscript && <TranscriptPane segments={state.segments} words={state.words} />}

      <footer className="status">
        <span>{state.notice ?? <RunStatus state={state} />}</span>
        <span className="keys">
          <kbd>1</kbd> to <kbd>9</kbd> pins a block for 15 s. <kbd>T</kbd> {showTranscript ? "hides" : "shows"} the transcript.
        </span>
      </footer>
    </div>
  );
}

function RunStatus({ state }: { state: SessionState }) {
  const { run, last } = state;
  if (!run) return null;
  if (run.status !== "running") {
    const s = run.summary;
    const ended = run.mode === "live" ? "Call ended." : run.status === "stopped" ? "Stopped." : "Finished.";
    const saved = run.audioPath ? ` Audio saved to ${run.audioPath}; play it under Recorded call.` : "";
    if (!s) return <>{ended}{saved}</>;
    const agreement = s.blockAgreement ? ` Block agreement ${pct(s.blockAgreement)}, stance ${pct(s.stanceAgreement)}.` : "";
    return (
      <>
        {ended}
        {agreement} Unknown {pct(s.unknown)}, {s.switchesPerMinute.toFixed(1)} switches a minute
        {s.lagMs ? `, lag p90 ${Math.round(s.lagMs.p90)} ms` : ""}.{saved || ` Log in ${run.logPath}`}
      </>
    );
  }
  if (!last) return <>{run.mode === "live" ? "Listening." : `Running ${run.name} with ${run.classifier}.`}</>;
  // Lag is measured in call time, so it only means something at real-time speed.
  const timing =
    run.speed === 1
      ? `On screen ${Math.round(last.lagMs)} ms after the sentence ended (classifier ${Math.round(last.latencyMs)} ms)`
      : `Classifier answered in ${Math.round(last.latencyMs)} ms`;
  return (
    <>
      {timing}
      {last.top ? `, raw top ${last.top.id} ${Math.round(last.top.p * 100)}%` : ""}.
    </>
  );
}

/** Plays a recorded call's audio while the transcriber hears it. */
function usePlayback(run: SessionState["run"]) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = run?.status === "running" ? run.audioUrl : null;
  useEffect(() => {
    if (!url) return;
    const el = new Audio(url);
    audio.current = el;
    void el.play().catch(() => undefined);
    return () => {
      el.pause();
      audio.current = null;
    };
  }, [url, run?.id]);
}
