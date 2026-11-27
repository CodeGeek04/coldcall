import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Transcript } from "./types";

const SegmentSchema = z
  .object({
    id: z.string().optional(),
    speaker: z.enum(["you", "them"]),
    text: z.string().min(1),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    label: z
      .object({
        block: z.string().optional(),
        stance: z.string().optional(),
      })
      .optional(),
  })
  .refine((s) => s.end >= s.start, { message: "end must be >= start" });

const TranscriptSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  segments: z.array(SegmentSchema).min(1),
});

/**
 * Transcript file format (JSON):
 * { id, description?, segments: [{ id?, speaker: "you"|"them", text, start, end, label?: { block?, stance? } }] }
 * Times are seconds from call start. `end` is when the segment became final.
 * Segments are sorted by `end`, and missing ids become s1, s2, ...
 */
export function parseTranscript(json: unknown): Transcript {
  const t = TranscriptSchema.parse(json);
  const segments = t.segments
    .map((s, i) => ({ ...s, id: s.id ?? `s${i + 1}` }))
    .sort((a, b) => a.end - b.end);
  return { ...t, segments };
}

export function loadTranscript(path: string): Transcript {
  return parseTranscript(JSON.parse(readFileSync(path, "utf8")));
}
