# Jev (TypeSafe System One): request shape and limits

Written 17 Nov 2026 from the official docs at docs.typesafe.ai. Items marked **(confirm)** get checked against the live API by `pnpm smoke`; record what it shows in the "Observed" section.

## Endpoint

- `POST https://api.typesafe.ai/v1/systemone`
- Headers: `Authorization: Bearer $TYPESAFE_API_KEY`, `Content-Type: application/json`
- `GET https://api.typesafe.ai/v1/models` lists models.
- Models: `jev-latest` (alias, currently `jev-1.14.0`), `jev-preview`, `jev-1.14.0`, `jev-1.13.0`. Aliases move on release, so pin a versioned id (`JEV_MODEL` in `.env`) once thresholds are tuned. Log `response.model` (the pipeline does).

## What we send

One request per final segment, three questions about the same `state`. Built by `buildJevRequest` in `src/classifiers/jev.ts`.

```json
{
  "model": "jev-latest",
  "state": {
    "current_block": "hook",
    "conversation": [
      { "from": "You", "text": "Could I have thirty seconds to explain why I called?" },
      { "from": "Them", "text": "Honestly, I'm between patients, and we already have a reminder system." }
    ]
  },
  "questions": {
    "block": {
      "type": "choice",
      "instructions": "This is a live cold sales call. In `conversation`, `You` is the caller ... Which stage is the call in now, judged by the latest turns of `conversation`?",
      "criteria": {
        "gatekeeper": "Someone other than the target answers, or asks who is calling and why.",
        "reluctant": "Prospect is pushing back (not interested, busy, have a vendor, send an email).",
        "discovery": { "what": "Prospect is describing their situation, tools or problems.", "examples": ["We use spreadsheets for that", "..."] }
      }
    },
    "stance": { "type": "choice", "instructions": "...", "criteria": { "open": "...", "neutral": "...", "reluctant": "...", "hostile": "...", "ready": "..." } },
    "readiness": { "type": "score", "instructions": "...", "criteria": ["Refuses to engage ...", "...", "Agrees to a next step ..."] }
  }
}
```

Notes:

- `state` can be a string, object or array. There is no built-in speaker field; we use our own `conversation` array, and instructions refer to fields by backtick path (`conversation`, `current_block`), as the docs recommend.
- `type` values are lowercase: `choice`, `score`, `noul`, `box`.
- Choice `criteria` is a map of option name to description (1 to 255 options). Both names and descriptions reach the model, so descriptions should separate options from each other.
- **Example utterances:** there is no `examples` field in the schema, but a description may be an object. The docs use `{ "what": ..., "examples": [...] }` and say those field names are not reserved. A block with `examples` in `playbook.yaml` is sent that way.
- Score `criteria` is an ordered list of 2 to 10 levels, lowest first. Docs: "Describe situations, not degrees."
- The docs advise against a "none of the above" option (it competes for probability). We do not add one: "unknown" comes from the state machine's probability threshold instead.

## What comes back

```json
{
  "model": "jev-1.14.0",
  "answers": {
    "block": { "type": "choice", "choice": "reluctant", "confidence": 0.8, "probabilities": { "reluctant": 0.82, "hook": 0.1 } },
    "stance": { "type": "choice", "choice": "reluctant", "confidence": 0.7, "probabilities": { "...": 0.0 } },
    "readiness": { "type": "score", "score": 1.2, "confidence": 0.6, "legend": { "0": "..." }, "probabilities": { "0": 0.2, "1": 0.5 } }
  },
  "usage": { "input_tokens": 412, "output_tokens": 3 }
}
```

- Choice: `choice` is the top option; `probabilities` covers every option and sums to about 1. `confidence` is 0 to 1, derived from how spread the probabilities are (formula not published).
- Score: `score` is the probability-weighted mean level index (can be fractional). The pipeline divides by `levels - 1` to get readiness from 0 to 1.
- The Python quickstart reads `response.choices[...]` while every other page and the API spec use `answers`. **(confirm)** We parse `answers`.
- Calibration is measured over groups of predictions; a single high-probability answer can still be wrong.

## Limits

| Limit | Value |
| --- | --- |
| Context per request (state + all questions) | 64k tokens (262k with header `TypeSafe-Danger-Zone-Long-Context: true`) |
| Context per question (state + one question) | 32k tokens |
| Body size | 32 MiB |
| Questions per request | no count limit; bounded by context. Questions run in parallel, so extra questions barely add latency. |
| Choice options | 1 to 255 |
| Score levels | 2 to 10 |
| Nesting depth | 64 |
| Price | $0.042 per million input tokens; output tokens free |
| Rate limits | per organization, tokens/s and requests/s; numbers only in the console (console.typesafe.ai/rate-limits) **(confirm)** |
| Latency | not published **(confirm)** |
| Request timeout | not published |

Our window is 8 segments, roughly 300 to 900 tokens with the three questions, far under every limit.

## Errors

| Status | Meaning | What the pipeline does |
| --- | --- | --- |
| 400 | Request rule broken, or `max_tokens_exceeded` | log, skip this result |
| 401 | Missing or bad key | log, skip |
| 413 / 415 | Body too large / bad compression | log, skip |
| 422 | Validation failure: `{ "detail": [{ "loc", "msg", "type", ... }] }` | log, skip |
| 429 | Rate limited | one retry after 250 ms, then skip |
| 529 | Temporarily overloaded | one retry after 250 ms, then skip |

A late result is useless on a live call, so there is a 5 s timeout and only one retry. Skipped results are logged as `error` records.

## SDK

The official package is `@typesafe-ai/sdk` (`new TypeSafeClient()`, `client.systemOne({ state, questions })`, typed `response.answers.<name>.choice`). We call the HTTP API with `fetch` instead, to keep the exact request visible and avoid an extra dependency. The SDK would add zstd compression for bodies over 1 KiB, which does not matter at our size.

## Observed (17 Nov 2026, `pnpm smoke` and two replays)

- **Model:** `jev-latest` returned `jev-1.14.0`. `GET /v1/models` lists only `jev-latest` (released 22 Oct 2026) and `jev-preview`.
- **Response shape:** matches the `answers` schema exactly. Score answers include `legend` and per-level `probabilities` keyed `"0"` to `"4"`.
- **Tokens:** about 1,000 to 1,250 input tokens per request (1,094 for the 4-turn smoke window; 32,401 over 27 replay requests). The three questions' instructions and option descriptions are most of it, so the window size barely matters. Output tokens about 160 (free). A 10-minute call at one request per 5 s is about 144,000 tokens, roughly $0.006.
- **Latency from this machine:** p50 312 ms, p90 395 ms (8 sequential requests); p50 338 ms, p90 399 ms over the 27-request real-time replay.
- **Probabilities are sharp:** most options come back at exactly 0, and the top is usually 0.85 to 1.0. Expect the 0.85 single-result switch to fire often.
- **Probes:** 4 of 4 blocks correct (gatekeeper 100%, discovery 99%, ask 85%, reluctant 82%); stances 4 of 4 (hostile only 58%).
- **Replay of `sample-booked` (hand-written, clean text):** raw top block matched the label 27 of 27 times; raw stance 21 of 27.
- **Replay of `sample-hostile`:** Jev called every hostile line `reluctant` (67% to 97%), and read "How did you get this number?" as `gatekeeper` (the gatekeeper description includes "asks who is calling and why").
- **Rate limits:** not checked yet; see console.typesafe.ai/rate-limits.
