import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillUsageEntry } from "./types.js";

type SkillUsageEvent = {
  observedAt: string;
  skillId?: string;
  skillName?: string;
};

/** Skill usage, from the bundled `skill-usage` plugin's own append-only event log
 * (`state/plugins/skill-usage/events/skill-usage-events.jsonl`), one JSON object per
 * invocation with an ISO `observedAt` timestamp. This is windowable directly (unlike the
 * plugin's cumulative sqlite counters, which only support before/after snapshot diffs), so
 * it works uniformly for both start/stop and arbitrary historical date-range probes.
 *
 * Returns `null` (not `{}`) when the log file itself is missing, so callers can distinguish
 * "skill-usage plugin not installed/enabled" from "zero skills used in this window". */
export async function collectSkillUsage(
  baseDir: string,
  tsStartMs: number,
  tsEndMs: number,
): Promise<Record<string, SkillUsageEntry> | null> {
  const path = join(baseDir, "state", "plugins", "skill-usage", "events", "skill-usage-events.jsonl");
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  const counts = new Map<string, SkillUsageEntry>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: SkillUsageEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const observedMs = Date.parse(event.observedAt);
    if (!Number.isFinite(observedMs) || observedMs < tsStartMs || observedMs > tsEndMs) continue;
    const key = event.skillId ?? event.skillName;
    if (!key) continue;
    const entry = counts.get(key) ?? { name: event.skillName ?? key, uses: 0 };
    entry.uses += 1;
    counts.set(key, entry);
  }
  return Object.fromEntries(counts);
}
