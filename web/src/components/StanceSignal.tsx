import type { CSSProperties } from "react";
import type { DisplayState } from "../../../src/core/types";

/** Stance as a signal lamp: the only colored thing on screen. Unknown stance ids fall back to neutral grey. */
export function StanceSignal({ display }: { display: DisplayState | null }) {
  const stance = display?.stance ?? null;
  const lamp = { "--lamp": stance ? `var(--stance-${stance}, var(--stance-neutral))` : "var(--rail)" } as CSSProperties;
  const confidence = display?.stanceConfidence ?? 0;
  const readiness = display?.readiness ?? null;

  return (
    <div className="signal" style={lamp}>
      <span className="lamp" aria-hidden="true" />
      <div className="signal-text">
        <span className="stance-name">{stance ?? "No stance yet"}</span>
        <span className="meter" role="meter" aria-label="Stance confidence" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(confidence * 100)}>
          <span style={{ "--v": confidence } as CSSProperties} />
        </span>
      </div>
      <span className="readiness-label">Readiness</span>
      <span className="meter readiness" role="meter" aria-label="Readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness === null ? 0 : Math.round(readiness * 100)}>
        <span style={{ "--v": readiness ?? 0 } as CSSProperties} />
      </span>
    </div>
  );
}
