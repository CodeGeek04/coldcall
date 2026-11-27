import { EventEmitter } from "node:events";
import type { Segment, Speaker } from "../core/types";

/** One word from the streaming transcriber, with punctuation attached. Times in seconds of audio. */
export interface StreamWord {
  word: string;
  start: number;
  end: number;
}

/** One streaming result for one channel, in the shape Deepgram uses. */
export interface StreamResult {
  channel: number;
  words: StreamWord[];
  /** This stretch of audio will not be transcribed again. */
  isFinal: boolean;
  /** The speaker paused long enough to end the utterance. */
  speechFinal: boolean;
}

export interface SegmenterOptions {
  /**
   * Interim text can still change. A sentence ending in interim text is trusted once this many
   * words follow it (the speaker has moved on); otherwise it waits for final text.
   */
  confirmAfterWords?: number;
  /**
   * A sentence whose full stop is the last word heard is sent after this much quiet from that
   * speaker, without waiting for final text. 0 turns this off.
   */
  quietMs?: number;
}

type Events = {
  /** A finished sentence, or the unpunctuated piece before a pause. */
  segment: [Segment];
  /** Final text for a sentence that was sent from interim text and came out different. */
  revise: [{ id: string; text: string; end: number }];
  /** Words heard but not yet sent, for display. Empty after a pause. */
  live: [{ speaker: Speaker; text: string }];
};

interface Sent {
  id: string;
  text: string;
  stable: boolean;
}

interface ChannelState {
  finalized: StreamWord[];
  interim: StreamWord[];
  sent: Sent[];
}

// "Dr." and friends end with a full stop but rarely end a sentence.
const NOT_AN_END = /^(dr|mr|mrs|ms|mx|st|jr|sr|vs|etc|inc|ltd|co|e\.g|i\.e|a\.m|p\.m)\.$/i;
const SENTENCE_END = /[.?!]["')\]]*$/;

function endsSentence(word: string): boolean {
  return SENTENCE_END.test(word) && !NOT_AN_END.test(word.replace(/^["'(\[]+/, ""));
}

interface Sentence {
  words: StreamWord[];
  /** Index in the utterance's word list of this sentence's last word. */
  lastIndex: number;
  complete: boolean;
}

function split(words: StreamWord[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: StreamWord[] = [];
  words.forEach((word, i) => {
    cur.push(word);
    if (endsSentence(word.word)) {
      out.push({ words: cur, lastIndex: i, complete: true });
      cur = [];
    }
  });
  if (cur.length) out.push({ words: cur, lastIndex: words.length - 1, complete: false });
  return out;
}

const text = (words: StreamWord[]) => words.map((w) => w.word).join(" ");

/**
 * Turns a word stream into segments for the classifier: one per finished sentence, sent as early
 * as it is safe to, plus whatever is pending when the speaker pauses. Channels are independent.
 */
export class SentenceSegmenter extends EventEmitter<Events> {
  private readonly state: ChannelState[];
  private readonly confirmAfterWords: number;
  private readonly quietMs: number;
  private readonly timers: (ReturnType<typeof setTimeout> | null)[];
  private count = 0;

  constructor(
    /** Speaker for each channel index. */
    private readonly speakers: Speaker[],
    opts: SegmenterOptions = {},
  ) {
    super();
    this.confirmAfterWords = opts.confirmAfterWords ?? 1;
    this.quietMs = opts.quietMs ?? 350;
    this.state = speakers.map(() => ({ finalized: [], interim: [], sent: [] }));
    this.timers = speakers.map(() => null);
  }

  onResult(r: StreamResult): void {
    const st = this.state[r.channel];
    if (!st) return;
    this.clearTimer(r.channel);
    if (r.isFinal) {
      st.finalized.push(...r.words);
      st.interim = [];
    } else {
      st.interim = r.words;
    }
    if (r.isFinal && r.speechFinal) this.flush(r.channel);
    else this.advance(r.channel);
  }

  /** Deepgram's word-gap based end of utterance; a fallback when speech_final never came. */
  onUtteranceEnd(channel: number): void {
    this.clearTimer(channel);
    this.flush(channel);
  }

  flushAll(): void {
    this.state.forEach((_, c) => {
      this.clearTimer(c);
      this.flush(c);
    });
  }

  private clearTimer(channel: number): void {
    const t = this.timers[channel];
    if (t) clearTimeout(t);
    this.timers[channel] = null;
  }

  /** `quiet`: the speaker has said nothing new for quietMs, so a trailing full stop is trusted. */
  private advance(channel: number, quiet = false): void {
    const st = this.state[channel]!;
    const words = [...st.finalized, ...st.interim];
    const sentences = split(words);
    let pendingFrom = 0;

    for (let j = 0; j < sentences.length; j++) {
      const s = sentences[j]!;
      const stable = s.lastIndex < st.finalized.length;
      if (j < st.sent.length) {
        this.reviseIfFinal(st.sent[j]!, s, stable);
        pendingFrom = s.lastIndex + 1;
        continue;
      }
      if (!s.complete) break;
      const followedBy = words.length - 1 - s.lastIndex;
      if (!stable && followedBy < this.confirmAfterWords && !(quiet && followedBy === 0)) {
        if (followedBy === 0 && this.quietMs > 0) {
          this.timers[channel] = setTimeout(() => {
            this.timers[channel] = null;
            this.advance(channel, true);
          }, this.quietMs);
        }
        break;
      }
      this.emitSegment(channel, s.words, stable);
      pendingFrom = s.lastIndex + 1;
    }
    this.emit("live", { speaker: this.speakers[channel]!, text: text(words.slice(pendingFrom)) });
  }

  private flush(channel: number): void {
    const st = this.state[channel]!;
    const words = [...st.finalized, ...st.interim];
    split(words).forEach((s, j) => {
      const sent = st.sent[j];
      if (sent) this.reviseIfFinal(sent, s, true);
      else this.emitSegment(channel, s.words, true);
    });
    const hadAnything = words.length > 0 || st.sent.length > 0;
    this.state[channel] = { finalized: [], interim: [], sent: [] };
    if (hadAnything) this.emit("live", { speaker: this.speakers[channel]!, text: "" });
  }

  private reviseIfFinal(sent: Sent, s: Sentence, stable: boolean): void {
    if (!stable || sent.stable) return;
    sent.stable = true;
    const now = text(s.words);
    if (now !== sent.text) {
      sent.text = now;
      this.emit("revise", { id: sent.id, text: now, end: s.words.at(-1)!.end });
    }
  }

  private emitSegment(channel: number, words: StreamWord[], stable: boolean): void {
    if (!words.length) return;
    const speaker = this.speakers[channel]!;
    const id = `${speaker}-${++this.count}`;
    const t = text(words);
    this.state[channel]!.sent.push({ id, text: t, stable });
    this.emit("segment", { id, speaker, text: t, start: words[0]!.start, end: words.at(-1)!.end });
  }
}
