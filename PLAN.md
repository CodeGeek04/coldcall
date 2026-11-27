# Cold-Call Stance Tracker: Prototype Build Plan

16 Nov 2026 · Shivam Mittal

## Goal and success criteria

The prototype listens to a live call on both sides and shows, about a second after each finished sentence, which block of the conversation you are in, what the prospect's stance is, and one line of direction. It never writes what to say. It is an experiment to learn whether a glanceable map helps, so build the smallest version that can answer that.

Starting targets (guesses to revise after the first real data):

- Display lag: 90% of updates within 1.5 s of the end of a finalized transcript segment
- Block agreement with your own hand labels: at least 75%
- Stance agreement with your hand labels: at least 70%
- Unwanted block switches (flicker): fewer than 1 per minute
- Every "unknown" is saved with its transcript, so the map can grow
- After five test calls, you would rather have the screen than not

## Architecture

Audio flows one way through the pipeline: Jev scores each final segment, and a plain state machine decides what you see.

```
Browser: mic (You) + call tab audio (Them)
   |  two channels over WebSocket
Server (Fastify + ws, holds API keys)
   |-> Transcriber (Deepgram, streaming) ------> final segments
   |-> Context window (last 8 final segments, labeled You:/Them:)
   |-> Classifier (Jev) ------------------------> raw block / stance / readiness probabilities
   |-> State machine (+ playbook.yaml) ---------> displayed state
   |-> UI over WebSocket: block map, stance chip, direction line
   '-> Session log (JSONL), so every call is replayable
```

The playbook file feeds both Jev's allowed answers and the direction lines on screen. The session log keeps every call replayable.

## Design decisions

Calling Jev after every finished sentence works, and cost and silence detection are not the problems. Two other things need care: the display must not follow every result, and the audio has to be captured in two channels.

1. **Trigger on each finished sentence, not only on pauses.** (Changed 17 Nov 2026.) Words stream in continuously and show live. A sentence goes to Jev as soon as it ends with `.`, `?` or `!`: at once if the speaker has already started the next sentence, otherwise when the transcriber confirms the text (about 0.3 s). A pause sends whatever is pending, punctuated or not. One Jev call per sentence from either speaker; later corrections to a sent sentence update the context window without a new call.
2. **Cost is negligible.** At the launch price of $0.042 per million input tokens (confirmed in the TypeSafe docs on 17 Nov 2026; output tokens are free), a 10-minute call with one call every 5 s is about 144,000 tokens, roughly $0.006 (measured: about 1,200 input tokens per request, mostly the question definitions). Transcription will cost more than classification.
3. **Results can arrive out of order.** Number every request; ignore any result older than the one already shown.
4. **The display lags the raw output on purpose.** Jev may flip block on every sentence. The state machine (see State logic) decides what you actually see, so the screen stays calm.
5. **Two channels beat diarization.** Capture your mic and the other side as separate channels, so "You" and "Them" are known without guessing from one mixed track.
6. **Text only goes to Jev.** Audio goes to the transcriber. Jev gets labeled text plus the current block.
7. **Directions are a lookup, not generated.** Jev picks the block, stance and readiness. Your playbook maps block plus stance to one line of direction.
8. **Keep both parts swappable.** Transcriber and Classifier are interfaces. Jev is one Classifier; a small LLM with structured output is the second, for a head-to-head on your recordings.
9. **Stack: TypeScript end to end.** Vite and React for the UI, Node (Fastify and ws) for the server that holds the API keys, so the browser does the audio capture and nothing else.
10. **Build replay first.** A replay mode feeds a recorded transcript through the same pipeline at real-time speed, so you can develop and tune without placing a call.
11. **Show the next move, not only the current block.** (Added 17 Nov 2026, after the first live test.) Knowing which block you are in only arrives once you have started it. Each block's exits are listed in `playbook.yaml` under `moves`, each with a plain-words trigger about what was just said. Every request asks Jev one yes/no question per exit from the current block; a trigger at 0.7 or above lights the next block ahead of you, with its reason and its direction. It holds until you reach that block, a stronger trigger wins, or its trigger reads under 0.3 twice.

## Audio capture for the first experiments

| Option | How | Use it for |
| --- | --- | --- |
| A. Browser call (recommended) | Both of you on Meet, Zoom web or WhatsApp web in Chrome. Capture the call tab's audio (them) plus your mic (you). | Friend tests |
| C. iPhone call on the Mac, with loopback (confirmed working) | The iPhone call rings on the Mac ("Calls from iPhone"). Route the call's output through a loopback device (BlackHole) for Them; your mic is You. Two clean channels, no diarization. | Real calls (round 3) |
| B. Phone on speaker | Phone on speakerphone next to the laptop. One mixed channel, so "You" and "Them" come from diarization and will be less accurate. | Fallback only, if C fails |

Tab audio capture works in Chrome on every OS. Capturing the whole system's audio from the browser only works on Windows, which is why option C uses a loopback device: the browser sees it as an ordinary input. Wear headphones for A and C, or your mic picks up the prospect from the speakers and their words land in both channels.

## Blocks and stances config

The whole map lives in one file, `playbook.yaml`, so you can add a block or rewrite a direction without touching code. The block and stance lists feed Jev as the allowed answers; the directions feed the UI. The v0 blocks are a starting guess, to be replaced by what your first 30 or so labeled calls show.

Three rules for writing the file:

- Describe each block by what is happening in the conversation, in one plain sentence. Jev only sees these words and the transcript.
- `next` is a soft hint for the state machine, not a hard rule. Cold calls loop, and any block can jump to exit.
- Directions are one line, and a stance-specific line wins over the block's default.

**Resolved open item (examples per option):** the Jev API has no dedicated examples field, but an option description can be an object instead of a string, and the docs use `{ what, examples: [...] }` for this. `playbook.yaml` accepts an optional `examples` list per block; the Jev classifier sends it that way. Add 2 or 3 real utterances per block from your recordings.

## State logic

The state machine turns Jev's raw probabilities into a calm display: it switches block only on sustained, confident evidence, and shows "unknown" when nothing is clear. All numbers below are starting values to tune on your recordings (they live in `src/core/stateMachine.ts` as `DEFAULT_TUNING`).

**Input per call.** The last 8 final segments (about the last minute), each labeled You: or Them:, plus the current block. One request asks three questions: which block, which stance, and how ready the prospect is (a 0 to 1 score).

Rules, in order:

1. **Unknown.** If the top block's probability is under 0.55, show "Unknown, on you". Keep the last confident block on screen, dimmed.
2. **Block switch.** Change the displayed block only when a challenger leads on 2 consecutive results with probability of at least 0.65, or once with at least 0.85.
3. **Backward moves.** Allowed (for example ready back to reluctant), with the same thresholds. A `next` hint in the playbook lowers the threshold slightly for expected moves; it never blocks an unexpected one.
4. **Stance.** Smooth with a short moving average over the last 3 results, so it reacts faster than the block does. Show the top stance and a confidence bar.
5. **Near ties.** When the top two blocks are within 0.15 of each other, show both, for example "Reluctant 52% / Discovery 40%".
6. **Stale results.** Each request carries a sequence number; drop any result older than the one on screen.
7. **Manual override.** Pressing a number key pins that block for 15 s and records your key press as a ground-truth label.
8. **Log everything.** Every evaluation (window, raw Jev output, displayed state, time) is appended to a JSONL file for replay and scoring.

The state machine is plain code with no model inside it, so the same rules run in replay and live.

## Screen layout

The screen has three parts you can read at a glance: the block map with the current block lit, a stance chip, and one direction line.

The lit block and the direction line carry the glance, and the transcript pane can be hidden. When nothing is confident, the map dims and the direction reads "Unclear. It is on you." When two blocks are close, both are shown with their probabilities.

## Milestones

Build in this order, so the risky parts (Jev quality and live audio) are tested before the UI is polished. Work through one milestone per Claude Code session.

1. **Jev smoke test.** Read the Jev docs, get an API key, send one hard-coded transcript with a block question, a stance question and a readiness score. Done when you see typed answers with probabilities, and you have written down the exact request shape and its limits (`docs/jev.md`).
2. **Replay harness.** Define a transcript JSON format (speaker, text, start and end times). Build the pipeline that streams a file through the context window, the Classifier and the state machine at real-time speed and prints the displayed state. Done when a hand-written 2-minute transcript produces a sensible block and stance sequence, and a JSONL log.
3. **Static UI with fake events.** Block map, stance chip, direction line and a small transcript pane, driven by the replay events over a WebSocket. Done when replaying a transcript animates the screen with no flicker you would not accept.
4. **Live transcription.** The browser captures your mic and the other side as two channels (the call tab's audio for Meet, or the loopback device for iPhone calls) and streams them to the server, which streams them to the transcriber. Done when a Meet call with your friend shows a correct You: / Them: transcript, with final segments appearing within about a second of speech.
5. **Live loop.** Connect the live transcript to the same pipeline and UI. Done when a scripted 3-minute call with your friend moves the screen as you expect, and lag is measured and logged.
6. **Recording and labeling.** Save audio, transcript and the pipeline log per session. Add a labeling view (or use the number-key overrides) to mark true block and stance per segment. Done when a finished call can be replayed with your labels beside the system's output.
7. **Scoring script.** Compute block and stance agreement, switch lag in seconds, flicker per minute and the unknown rate from the labeled sessions. Run the same sessions through the second Classifier for a head-to-head. Done when one command prints the table for any set of sessions.
8. **Friend sessions.** Run the protocol in the next section.

## Experiment protocol with your friend

Run three rounds, each answering a different question: does the pipeline work, is the map accurate, and is it useful in the moment.

| Round | Calls | Your friend plays | Question answered |
| --- | --- | --- | --- |
| 1. Scripted | 6 | One persona per call: gatekeeper, busy, already has a vendor, curious, hostile, ready to book | Does the pipeline work, and is lag acceptable? |
| 2. Free-form | 6 | Whatever they like, changing their mind mid-call | How accurate are block and stance against your labels? |
| 3. Real calls | A handful | Real prospects, iPhone calls taken on the Mac (option C) | Is the screen useful when it matters? |

After every call:

- Label the true block and stance per segment (number-key overrides plus the labeling view).
- Rate 1 to 5: "Did glancing at the screen help?" and "Did it ever mislead me?"
- Write down every moment it showed "unknown", and what the block should have been. Those become new blocks or better descriptions.

Measure: block agreement, stance agreement, switch lag in seconds, flicker per minute, unknown rate, and the two self-ratings. Run the same recordings through the Jev and the fallback Classifier to see whether Jev earns its place.

Get consent before recording. Tell your friend, and check the recording and consent rules for real prospects before round 3.

## Risks and open questions

The biggest unknowns are how Jev behaves on real call text and how to capture phone audio.

- **Jev maturity.** It launched in early access on 15 Sep 2026, and the speed, price and accuracy figures are the vendor's. Request limits are documented (see `docs/jev.md`); rate-limit numbers are only in the console, and latency is unmeasured until the smoke test runs.
- **Phone audio.** Real calls are cellular, so the prospect's side is narrowband and can be noisy even with clean channel separation through the Mac. Expect worse transcripts than the Meet tests. Not yet tested: whether the Calls from iPhone audio routes cleanly through a Multi-Output Device with BlackHole.
- **Taxonomy.** The v0 blocks may be wrong. The first labeled calls will show which blocks blur together; merge them rather than adding more.
- **Attention.** The screen can distract you from listening. Keep one highlighted block and one direction line, and test with the transcript pane hidden.
- **Consent.** Recording and transcribing calls needs consent in many places.

## Progress

- **Milestone 1, done 17 Nov 2026.** Request shape, limits and measured behavior in `docs/jev.md`. Jev p50 312 ms, about 1,200 input tokens per request.
- **Milestone 2, done 17 Nov 2026.** `pnpm replay`. On `sample-booked` through Jev: block agreement 81%, stance 74%, 0 wrong switches, display lag p90 399 ms. Every miss on screen was the switch rule holding one sentence back; Jev's raw top block was right on 27 of 27.
- **Milestone 3, built 17 Nov 2026; flicker check is yours.** `pnpm dev`, then open localhost:5173 and replay a transcript. Keys 1 to 9 pin a block, T hides the transcript.
- **Milestones 4 and 5, built 17 Nov 2026; first real call pending.** Live call mode captures mic + BlackHole (or a Chrome tab) as two channels; Deepgram streams every word; the segmenter sends each sentence to Jev. Tested with generated two-voice audio (`pnpm make-audio`, `pnpm live-file`, and the screen's Recorded call mode) and a fake browser microphone. On the 2-minute recording, with the 350 ms quiet timer: block agreement 74%, stance 79%, 0 wrong switches, 61 sentences; lag from the end of speech to the screen p50 1.0 s, p90 1.3 s, 92% within 1.5 s. Jev is about 315 ms of that; the transcriber (p50 685 ms) is the rest.

- **Next move, built 17 Nov 2026.** Replaying the first live test call: "Next" appeared before the caller started the block for discovery (3.3 s), pitch (8.9 s), ask (11.3 s) and exit (7.4 s); hook and logistics came within 0.5 s after. The first live test call showed every block lighting 1 to 7 s after the caller had already started it. Jev time unchanged (p50 332 ms); about 1,500 input tokens per request.

## Decisions log

Answers to the plan's open questions (17 Nov 2026):

- **How calls are placed today:** iPhone. "Calls from iPhone" on the Mac works, so real calls in round 3 use option C (call audio on the Mac, loopback for Them, mic for You). Friend tests use option A (Meet in Chrome). Both give two channels; single-channel diarization (option B) stays as a fallback in the Transcriber interface.
- **Languages:** English only. The Hindi/Hinglish risk is dropped.
- **Jev access:** direct TypeSafe API key (`api.typesafe.ai`), not a gateway.
- **Transcriber:** Deepgram streaming, multichannel for options A and C, diarization only for the option B fallback.
- **Stances get descriptions:** the plan listed stances as bare names. Jev reads option descriptions, so `playbook.yaml` now gives each stance one plain sentence too. Readiness levels are described there as well.
