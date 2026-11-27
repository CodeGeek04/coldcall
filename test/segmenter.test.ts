import { afterEach, describe, expect, it, vi } from "vitest";
import { SentenceSegmenter, type StreamWord } from "../src/transcribe/segmenter";
import type { Segment } from "../src/core/types";

/** Words with made-up timings: 0.3 s each, starting at `at`. */
function w(text: string, at = 0): StreamWord[] {
  return text.split(" ").map((word, i) => ({ word, start: at + i * 0.3, end: at + i * 0.3 + 0.25 }));
}

function setup(confirmAfterWords = 1, quietMs = 0) {
  const seg = new SentenceSegmenter(["you", "them"], { confirmAfterWords, quietMs });
  const segments: Segment[] = [];
  const revisions: { id: string; text: string }[] = [];
  const live: { speaker: string; text: string }[] = [];
  seg.on("segment", (s) => segments.push(s));
  seg.on("revise", (r) => revisions.push({ id: r.id, text: r.text }));
  seg.on("live", (l) => live.push(l));
  return { seg, segments, revisions, live, texts: () => segments.map((s) => s.text) };
}

describe("SentenceSegmenter", () => {
  it("sends nothing while a sentence is still going", () => {
    const { seg, segments } = setup();
    seg.onResult({ channel: 1, words: w("We already have a"), isFinal: false, speechFinal: false });
    expect(segments).toHaveLength(0);
  });

  it("sends a sentence as soon as the next one starts, before any pause", () => {
    const { seg, texts } = setup();
    seg.onResult({ channel: 1, words: w("We already have a vendor. But"), isFinal: false, speechFinal: false });
    expect(texts()).toEqual(["We already have a vendor."]);
  });

  it("waits for confirmation when the full stop is the last word heard", () => {
    const { seg, texts } = setup();
    seg.onResult({ channel: 1, words: w("We already have a vendor."), isFinal: false, speechFinal: false });
    expect(texts()).toEqual([]);
    seg.onResult({ channel: 1, words: w("We already have a vendor."), isFinal: true, speechFinal: false });
    expect(texts()).toEqual(["We already have a vendor."]);
  });

  it("sends each sentence once, in order, across interim updates", () => {
    const { seg, texts } = setup();
    seg.onResult({ channel: 1, words: w("Sure. What"), isFinal: false, speechFinal: false });
    seg.onResult({ channel: 1, words: w("Sure. What does it cost? We"), isFinal: false, speechFinal: false });
    seg.onResult({ channel: 1, words: w("Sure. What does it cost? We just spent a lot."), isFinal: true, speechFinal: true });
    expect(texts()).toEqual(["Sure.", "What does it cost?", "We just spent a lot."]);
  });

  it("sends an unpunctuated piece when the speaker pauses", () => {
    const { seg, texts, live } = setup();
    seg.onResult({ channel: 1, words: w("um maybe Thursday"), isFinal: true, speechFinal: true });
    expect(texts()).toEqual(["um maybe Thursday"]);
    expect(live.at(-1)).toEqual({ speaker: "them", text: "" });
  });

  it("flushes on UtteranceEnd when Deepgram never marks speech_final", () => {
    const { seg, texts } = setup();
    seg.onResult({ channel: 0, words: w("Could I have thirty seconds"), isFinal: true, speechFinal: false });
    expect(texts()).toEqual([]);
    seg.onUtteranceEnd(0);
    expect(texts()).toEqual(["Could I have thirty seconds"]);
    seg.onUtteranceEnd(0);
    expect(texts()).toHaveLength(1);
  });

  it("revises a sent sentence when the final text differs, without sending it again", () => {
    const { seg, texts, revisions } = setup();
    seg.onResult({ channel: 1, words: w("We use spread sheets. And"), isFinal: false, speechFinal: false });
    expect(texts()).toEqual(["We use spread sheets."]);
    seg.onResult({ channel: 1, words: w("We use spreadsheets. And it works."), isFinal: true, speechFinal: true });
    expect(texts()).toEqual(["We use spread sheets.", "And it works."]);
    expect(revisions).toEqual([{ id: expect.any(String), text: "We use spreadsheets." }]);
  });

  it("keeps the two speakers apart", () => {
    const { seg, segments } = setup();
    seg.onResult({ channel: 0, words: w("Hi, is this Jordan? This"), isFinal: false, speechFinal: false });
    seg.onResult({ channel: 1, words: w("Who is this? I"), isFinal: false, speechFinal: false });
    expect(segments.map((s) => [s.speaker, s.text])).toEqual([
      ["you", "Hi, is this Jordan?"],
      ["them", "Who is this?"],
    ]);
  });

  it("does not end a sentence on a title like Dr.", () => {
    const { seg, texts } = setup();
    seg.onResult({ channel: 0, words: w("Could I speak with Dr. Patel, please? Thanks"), isFinal: false, speechFinal: false });
    expect(texts()).toEqual(["Could I speak with Dr. Patel, please?"]);
  });

  it("takes start and end times from the words, and gives unique ids", () => {
    const { seg, segments } = setup();
    seg.onResult({ channel: 1, words: w("Yes. No.", 10), isFinal: true, speechFinal: true });
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [10, 10.25],
      [10.3, 10.55],
    ]);
    expect(new Set(segments.map((s) => s.id)).size).toBe(2);
  });

  it("can require more words after a full stop before trusting interim text", () => {
    const { seg, texts } = setup(2);
    seg.onResult({ channel: 1, words: w("We have a vendor. But"), isFinal: false, speechFinal: false });
    expect(texts()).toEqual([]);
    seg.onResult({ channel: 1, words: w("We have a vendor. But honestly"), isFinal: false, speechFinal: false });
    expect(texts()).toEqual(["We have a vendor."]);
  });

  it("shows the words not yet sent as live text", () => {
    const { seg, live } = setup();
    seg.onResult({ channel: 1, words: w("Okay. What does"), isFinal: false, speechFinal: false });
    expect(live.at(-1)).toEqual({ speaker: "them", text: "What does" });
  });
});

describe("SentenceSegmenter quiet timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a sentence whose full stop is the last word once the speaker has been quiet", () => {
    vi.useFakeTimers();
    const { seg, texts } = setup(1, 350);
    seg.onResult({ channel: 1, words: w("We already have a vendor."), isFinal: false, speechFinal: false });
    vi.advanceTimersByTime(349);
    expect(texts()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(texts()).toEqual(["We already have a vendor."]);
  });

  it("restarts the wait when more words arrive, and never sends twice", () => {
    vi.useFakeTimers();
    const { seg, texts } = setup(1, 350);
    seg.onResult({ channel: 1, words: w("We already have a vendor."), isFinal: false, speechFinal: false });
    vi.advanceTimersByTime(200);
    seg.onResult({ channel: 1, words: w("We already have a vendor. But"), isFinal: false, speechFinal: false });
    expect(texts()).toEqual(["We already have a vendor."]);
    vi.advanceTimersByTime(1000);
    expect(texts()).toEqual(["We already have a vendor."]);
  });

  it("turns Deepgram's later final text into a correction, not a second sentence", () => {
    vi.useFakeTimers();
    const { seg, texts, revisions } = setup(1, 350);
    seg.onResult({ channel: 0, words: w("I'll keep it to a minit."), isFinal: false, speechFinal: false });
    vi.advanceTimersByTime(350);
    seg.onResult({ channel: 0, words: w("I'll keep it to a minute."), isFinal: true, speechFinal: true });
    expect(texts()).toEqual(["I'll keep it to a minit."]);
    expect(revisions.map((r) => r.text)).toEqual(["I'll keep it to a minute."]);
  });

  it("does not wait on unpunctuated text: that still needs a pause from the transcriber", () => {
    vi.useFakeTimers();
    const { seg, texts } = setup(1, 350);
    seg.onResult({ channel: 1, words: w("so the thing is"), isFinal: false, speechFinal: false });
    vi.advanceTimersByTime(2000);
    expect(texts()).toEqual([]);
  });
});
