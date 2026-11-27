import { useEffect, useRef } from "react";
import type { Segment, Speaker } from "../../../src/core/types";

const NAME: Record<Speaker, string> = { you: "You", them: "Them" };

/**
 * Sentences sent to the classifier, newest at the bottom, then the words still being spoken.
 * Hidden with T.
 */
export function TranscriptPane({ segments, words }: { segments: Segment[]; words: Record<Speaker, string> }) {
  const end = useRef<HTMLDivElement>(null);
  const speaking = (Object.keys(words) as Speaker[]).filter((s) => words[s]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [segments.length, words.you, words.them]);

  return (
    <section className="transcript" aria-label="Transcript">
      {segments.length === 0 && speaking.length === 0 ? (
        <p className="transcript-empty">What each side says appears here as the call goes.</p>
      ) : (
        <ol>
          {segments.map((s) => (
            <li key={s.id} data-speaker={s.speaker}>
              <span className="who">{NAME[s.speaker]}</span>
              <span className="said">{s.text}</span>
            </li>
          ))}
          {speaking.map((s) => (
            <li key={`live-${s}`} data-speaker={s} className="speaking">
              <span className="who">{NAME[s]}</span>
              <span className="said">{words[s]}</span>
            </li>
          ))}
        </ol>
      )}
      <div ref={end} />
    </section>
  );
}
