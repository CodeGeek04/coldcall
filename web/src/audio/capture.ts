/** Where the other side of the call comes from. */
export type ThemSource = { kind: "device"; deviceId: string } | { kind: "tab" };

export interface CaptureSources {
  youDeviceId: string;
  them: ThemSource;
  /**
   * Output device to play the other side on, or null. Needed when the call app sends its sound
   * straight to BlackHole (call apps refuse Multi-Output Devices), so you can still hear them.
   */
  hearThemOn?: string | null;
}

// Devices that feed back into the capture (or go nowhere) if the other side is played on them.
const LOOPBACK = /blackhole|call capture|multi-output|appvolume/i;
const REAL_OUTPUT = /speaker|headphone|airpods|buds|wh-|wf-|bose|jabra/i;

/** The Mac's current output, if it is a loopback device: then nothing on the Mac is audible. */
export async function loopbackSystemOutput(): Promise<string | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const def = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default");
  const name = def?.label.replace(/^Default - /, "") ?? "";
  return LOOPBACK.test(name) ? name : null;
}

/** Where to play the other side by default: the Mac's current output if it is safe, else a real speaker or headset. */
export function defaultHearOn(outputs: MediaDeviceInfo[]): string {
  return (
    outputs.find((d) => d.deviceId === "default")?.deviceId ??
    outputs.find((d) => REAL_OUTPUT.test(d.label))?.deviceId ??
    outputs[0]?.deviceId ??
    ""
  );
}

export interface Capture {
  stop(): void;
}

/**
 * Lists audio inputs with their names. Browsers hide names until the page has microphone
 * permission, so this asks once if needed.
 */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.kind === "audioinput" && d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
}

/** Outputs that are safe for hearing the other side: no loopback devices. "default" is the Mac's current output. */
export async function listOutputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "communications" && !LOOPBACK.test(d.label));
}

/** BlackHole for the other side if it is there (iPhone calls through Call Capture), else a tab. */
export function defaultSources(inputs: MediaDeviceInfo[]): CaptureSources | null {
  const blackhole = inputs.find((d) => /blackhole/i.test(d.label));
  const mics = inputs.filter((d) => d !== blackhole);
  const you = mics.find((d) => /macbook|built-in/i.test(d.label)) ?? mics[0];
  if (!you) return null;
  return { youDeviceId: you.deviceId, them: blackhole ? { kind: "device", deviceId: blackhole.deviceId } : { kind: "tab" } };
}

/**
 * Captures you and them as two channels, 16 kHz 16-bit PCM in 100 ms chunks.
 * No processing on the other side's audio. Your mic has echo cancellation on: without headphones
 * it hears the other side from the speakers, and Chrome removes the sound it is playing itself.
 */
export async function startCapture(
  sources: CaptureSources,
  onChunk: (pcm: ArrayBuffer) => void,
  onLevels: (levels: [number, number]) => void,
): Promise<Capture> {
  const streams: MediaStream[] = [];
  const stopStreams = () => streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  try {
    const you = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: sources.youDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streams.push(you);

    let them: MediaStream;
    if (sources.them.kind === "device") {
      them = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: sources.them.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streams.push(them);
    } else {
      them = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // Chrome-only hints: offer tabs, not this one, and no whole-system audio.
        ...({ preferCurrentTab: false, selfBrowserSurface: "exclude", systemAudio: "exclude" } as object),
      });
      streams.push(them);
      them.getVideoTracks().forEach((t) => t.stop());
      if (!them.getAudioTracks().length) {
        throw new Error('No tab audio was shared. Start again, pick the call\'s tab, and turn on "Also share tab audio".');
      }
    }

    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const merger = ctx.createChannelMerger(2);
    const [, themSource] = [you, them].map((stream, channel) => {
      const source = ctx.createMediaStreamSource(stream);
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      mono.channelInterpretation = "speakers";
      source.connect(mono).connect(merger, 0, channel);
      return source;
    });
    if (sources.hearThemOn && themSource) {
      // Chrome can send this page's sound to a chosen output; "" is the Mac's current one.
      const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      await withSink.setSinkId?.(sources.hearThemOn === "default" ? "" : sources.hearThemOn);
      themSource.connect(ctx.destination);
    }
    const encoder = new AudioWorkletNode(ctx, "pcm-encoder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    merger.connect(encoder);
    // The encoder must be pulled by the graph to run; route it to the speakers at zero volume.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    encoder.connect(silent).connect(ctx.destination);
    encoder.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; levels: [number, number] }>) => {
      onChunk(e.data.pcm);
      onLevels(e.data.levels);
    };
    await ctx.resume();

    return {
      stop() {
        encoder.port.onmessage = null;
        stopStreams();
        void ctx.close();
      },
    };
  } catch (err) {
    stopStreams();
    throw err;
  }
}
