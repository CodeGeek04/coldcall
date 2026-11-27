# Cold-call stance tracker

A prototype that listens to a call, and about a second after each finished sentence shows which block of the conversation you are in, the prospect's stance, and one line of direction. See `PLAN.md` for the full plan and milestones.

## Setup

```sh
pnpm install
cp .env.example .env   # add TYPESAFE_API_KEY
```

Node 22.15 or newer.

## Commands

```sh
pnpm dev                                            # the screen at http://localhost:5173 (server on 8787)
pnpm make-audio transcripts/sample-booked.json      # turn a typed call into two-channel audio (macOS voices)
pnpm live-file transcripts/audio/sample-booked.wav  # stream audio through Deepgram, the segmenter and Jev
pnpm smoke                                          # milestone 1: one live Jev request, probes, latency
pnpm replay transcripts/sample-booked.json          # milestone 2: replay at real-time speed through Jev
pnpm replay transcripts/sample-booked.json --fast   # no waiting between segments
pnpm replay transcripts/sample-booked.json --classifier mock   # offline, no API calls
pnpm test
pnpm typecheck
```

Each replay writes `sessions/<time>-replay-<name>/pipeline.jsonl` (every segment, evaluation, override and error) and `unknowns.jsonl` (every unknown with its transcript window). `sessions/` is gitignored because recordings and transcripts can hold personal data.

## Layout

```
playbook.yaml              blocks, stances, readiness levels, directions: edit without touching code
src/core/types.ts          Segment, Classifier, DisplayState
src/core/stateMachine.ts   the rules from PLAN.md "State logic" (tuning in DEFAULT_TUNING)
src/core/pipeline.ts       final segment -> window -> classifier -> state machine -> events + log
src/classifiers/jev.ts     Jev request builder and client
src/classifiers/mock.ts    offline stand-in that adds noise to hand labels
src/replay/                replay CLI and drivers
src/transcribe/            Deepgram streaming client and the sentence segmenter (when a sentence goes to Jev)
src/audio/wav.ts           WAV read/write for recordings
src/server/                Fastify + WebSocket server: typed, recorded and live calls; holds API keys
src/shared/protocol.ts     messages between server and browser
web/                       the screen (Vite + React): track map, stance signal, direction, transcript
scripts/jev-smoke.ts       milestone 1 smoke test
transcripts/               hand-written, hand-labeled transcripts
docs/jev.md                Jev request shape, limits and observed behavior
```

## Live calls

Pick **Live call** in the screen's mode menu.

- **iPhone calls on the Mac:** in the call app's Audio menu, set Microphone to the MacBook microphone and Output to **BlackHole 2ch** (call apps refuse Multi-Output Devices like Call Capture and switch back to the headphones). Here, choose **You: MacBook Pro Microphone**, **Them: BlackHole 2ch**, and **Hear them on: your headphones**: the page plays the other side to you. Start listening before the call connects, and keep it running until the call ends, or you will not hear them.
- **Meet or Zoom web:** choose **Them: a Chrome tab**, then pick the call's tab and turn on "Also share tab audio".

Both level meters should move when each side talks. **Save audio** writes `audio.wav` (you left, them right) into the session folder; get consent first.

## Transcript format

```json
{
  "id": "sample-booked",
  "segments": [
    { "speaker": "them", "start": 0.0, "end": 2.2, "text": "Good morning, Cedar Dental.", "label": { "block": "gatekeeper", "stance": "neutral" } }
  ]
}
```

Times are seconds from call start; `end` is when the segment became final, which is when the pipeline sees it. `label` is optional ground truth and is never sent to the classifier.
