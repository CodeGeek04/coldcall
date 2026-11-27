import { useCallback, useEffect, useRef, useState } from "react";
import { listInputs, listOutputs, loopbackSystemOutput, startCapture, type Capture, type CaptureSources } from "./audio/capture";
import type { Run } from "./useSession";

/**
 * Microphone and call-audio capture for live calls. Audio is captured as soon as the call starts
 * but only forwarded once the server says the transcriber is ready.
 */
export function useLive(run: Run | null, notice: string | null, sendAudio: (pcm: ArrayBuffer) => void) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  /** Set when the Mac's sound output is a loopback device, so nothing is audible. */
  const [silentOutput, setSilentOutput] = useState<string | null>(null);
  const loaded = useRef(false);
  const [levels, setLevels] = useState<[number, number]>([0, 0]);
  const [capturing, setCapturing] = useState(false);
  const capture = useRef<Capture | null>(null);
  const forwarding = useRef(false);
  const waiting = useRef(false);

  const stop = useCallback(() => {
    capture.current?.stop();
    capture.current = null;
    forwarding.current = false;
    waiting.current = false;
    setCapturing(false);
    setLevels([0, 0]);
  }, []);

  const loadInputs = useCallback(async () => {
    const list = await listInputs();
    setInputs(list);
    setOutputs(await listOutputs());
    setSilentOutput(await loopbackSystemOutput());
    loaded.current = true;
    return list;
  }, []);

  // Keep the lists current when devices or the Mac's output change.
  useEffect(() => {
    const onChange = () => {
      if (loaded.current) void loadInputs().catch(() => undefined);
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [loadInputs]);

  const start = useCallback(
    async (sources: CaptureSources) => {
      stop();
      waiting.current = true;
      capture.current = await startCapture(sources, (pcm) => forwarding.current && sendAudio(pcm), setLevels);
      setCapturing(true);
    },
    [sendAudio, stop],
  );

  // Forward audio while the live run is going; release the devices when it ends.
  useEffect(() => {
    const liveRunning = run?.mode === "live" && run.status === "running";
    if (liveRunning) {
      forwarding.current = true;
      waiting.current = false;
    } else if (!waiting.current && capture.current) {
      stop();
    }
  }, [run?.id, run?.mode, run?.status, stop]);

  // The server refused to start (bad key, network): stop listening.
  useEffect(() => {
    if (notice && waiting.current) stop();
  }, [notice, stop]);

  useEffect(() => stop, [stop]);

  return { inputs, outputs, silentOutput, loadInputs, levels, capturing, start, stop };
}

export function captureErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "The browser was not allowed to use that input. Allow microphone access in the address bar, then start again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "That input is not connected any more. Pick it again, then start.";
  if (name === "NotReadableError") return "Another app is holding that input. Close it or pick another, then start.";
  return err instanceof Error ? err.message : String(err);
}
