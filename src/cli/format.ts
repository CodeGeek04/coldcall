import { styleText } from "node:util";
import type { Evaluation } from "../core/pipeline";
import { LAG_TARGET_MS, pct, type Summary } from "../core/summary";
import type { Segment } from "../core/types";

const PAD = " ".repeat(9);

export function formatEvaluation(e: Evaluation): string {
  if (e.stale) return styleText("dim", `${PAD}#${e.seq} stale result dropped`);
  const st = e.state;
  const blockName = (st.block ?? "none").toUpperCase();
  let block: string;
  if (st.unknown) block = styleText("yellow", `unknown (${st.block ? blockName + " dimmed" : "nothing lit"})`);
  else if (st.switched) block = styleText(["bold", "green"], `${blockName} *`);
  else block = styleText("bold", blockName);

  const stance = st.stance ? `${st.stance} ${Math.round(st.stanceConfidence * 100)}%` : "-";
  const ready = st.readiness === null ? "-" : st.readiness.toFixed(2);
  const raw = st.top ? `raw ${st.top.id} ${Math.round(st.top.p * 100)}%` : "";
  const tie = st.tie ? `  tie ${st.tie.map((t) => `${t.id} ${Math.round(t.p * 100)}%`).join(" / ")}` : "";
  const lag = `lag ${ms(e.lagMs)}`;
  const next = st.next ? `  ${styleText(["bold", "cyan"], `NEXT ${st.next.block.toUpperCase()} ${Math.round(st.next.p * 100)}%`)}` : "";

  const label = e.segment.label;
  let check = "";
  if (label?.block || label?.stance) {
    const bOk = !label.block || (!st.unknown && st.block === label.block);
    const sOk = !label.stance || st.stance === label.stance;
    check = bOk && sOk ? styleText("green", "ok") : styleText("red", `label ${label.block ?? "?"}/${label.stance ?? "?"}`);
  }
  return `${PAD}#${e.seq} ${block}${next}  ${stance}  ready ${ready}  ${styleText("dim", `${raw}${tie}  ${lag}`)}  ${check}`;
}

export function formatDirection(direction: string): string {
  return `${PAD}${styleText("cyan", "> " + (direction || "(no direction written for this block)"))}`;
}

export function clockLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, "0");
  return `[${String(m).padStart(2, "0")}:${s}]`;
}

export function speakerLabel(s: Segment): string {
  return s.speaker === "you" ? styleText("blue", "You: ") : styleText("magenta", "Them:");
}

export function ms(n: number): string {
  return `${Math.round(n)} ms`;
}

export function printSummary(s: Summary, logPath: string, opts: { lagMeaningful: boolean; extra?: string[] }): void {
  const lagNote = opts.lagMeaningful ? "" : " (not meaningful at this speed)";
  const lines = [
    "",
    `${styleText("bold", "Summary")}  ${s.evaluations} evaluations, ${s.stale} stale, ${s.failures} failed, ${s.callMinutes.toFixed(1)} min of call`,
    `  Block agreement   ${pct(s.blockAgreement)}   target 75%`,
    `  Stance agreement  ${pct(s.stanceAgreement)}   target 70%`,
    `  Unknown           ${pct(s.unknown)}`,
    `  Switches          ${s.switches} (${s.switchesPerMinute.toFixed(1)}/min), disagreeing with label: ${pct(s.wrongSwitches)}`,
    `  Display lag       ${s.lagMs ? `p50 ${ms(s.lagMs.p50)}, p90 ${ms(s.lagMs.p90)}, max ${ms(s.lagMs.max)}` : "n/a"}${lagNote}`,
    `  Within ${LAG_TARGET_MS} ms    ${pct(s.lagWithinTarget)}   target 90%`,
    `  Classifier time   ${s.latencyMs ? `p50 ${ms(s.latencyMs.p50)}, p90 ${ms(s.latencyMs.p90)}` : "n/a"}`,
    ...(opts.extra ?? []),
    `  Input tokens      ${s.inputTokens || "n/a"}`,
    `  Log               ${logPath}`,
  ];
  console.log(lines.join("\n"));
}
