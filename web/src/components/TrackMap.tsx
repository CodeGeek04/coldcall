import type { CSSProperties } from "react";
import type { DisplayState } from "../../../src/core/types";
import type { PlaybookView } from "../../../src/shared/protocol";

interface Props {
  blocks: PlaybookView["blocks"];
  display: DisplayState | null;
  onPin: (block: string) => void;
}

/**
 * The block map, drawn like a signal-box track diagram: one section per block, in call order.
 * The occupied section is lit and widens; a close runner-up is outlined with its probability.
 */
export function TrackMap({ blocks, display, onPin }: Props) {
  const lit = display?.block ?? null;
  const next = display?.next?.block ?? null;
  const unknown = display?.unknown ?? true;
  const tie = display?.tie ?? null;
  const tieP = (id: string) => tie?.find((t) => t.id === id)?.p;

  return (
    <div className="track" data-unknown={unknown} data-has-next={next !== null} role="group" aria-label="Call blocks">
      {blocks.map((b) => {
        const isLit = b.id === lit;
        const isNext = b.id === next;
        const p = isNext ? undefined : tieP(b.id);
        const runnerUp = !isLit && !isNext && p !== undefined;
        const pinned = isLit && display?.pinned ? display.pinned : null;
        const pinMs = pinned && display ? Math.max(0, pinned.untilMs - display.atMs) : 0;
        return (
          <button
            key={b.id}
            type="button"
            className="section"
            data-lit={isLit}
            data-next={isNext}
            data-runner-up={runnerUp}
            aria-pressed={isLit}
            title={`${b.describe}${b.key ? ` (press ${b.key} to pin)` : ""}`}
            onClick={() => onPin(b.id)}
          >
            {/* Keyed by the suggestion so the route-set pulse replays when it changes. */}
            <span className="rail" key={isNext ? `next-${b.id}` : "rail"}>
              {isLit && <span className="lit-name">{titleCase(b.id)}</span>}
              {isNext && (
                <span className="lit-name">
                  <span className="next-tag">Next</span> {titleCase(b.id)}
                </span>
              )}
              {p !== undefined && <span className="prob">{Math.round(p * 100)}%</span>}
              {pinned && <span key={pinned.untilMs} className="drain" style={{ "--pin-ms": `${pinMs}ms` } as CSSProperties} />}
            </span>
            <span className="caption">
              {b.key && <kbd>{b.key}</kbd>}
              <span className="caption-name">{pinned ? "pinned" : isLit && next ? "you are here" : b.id}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, " ");
}
