import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HookAgentContext, PluginLogger, SkillUsageEntry } from "./types.js";

/**
 * Skill usage detection, self-contained - no dependency on the separately-installed
 * `skill-usage` plugin.
 *
 * OpenClaw has no dedicated "run a skill" tool call to hook: eligible skills are listed in
 * the system prompt's `<available_skills>` block, and the model "uses" one by reading its
 * `SKILL.md` file with the normal file-read tool, same as reading any other file (see
 * docs/tools/skills.md). So detection means watching `after_tool_call` for a read-family
 * tool whose target path's basename is `SKILL.md`, then recovering the skill's declared name
 * from the YAML frontmatter of the file content the read returned. This is the same
 * technique the `skill-usage` plugin itself uses internally (confirmed by reading its
 * source) - replicating it here just means probe no longer needs that plugin installed to
 * report `skills_used`.
 *
 * Unlike llm_input/llm_output, `after_tool_call` already carries both `params` (with the
 * read path) and `result` (with the file content) on one event, so no before/after
 * correlation or pending-state map is needed here - one hook, one event, done.
 */

const READ_TOOL_NAMES = new Set(["read", "functions.read", "read_file", "filesystem.read", "fs.read"]);
const PATH_PARAM_KEYS = ["path", "file_path", "filePath", "filename", "targetPath", "uri"];

function extractPathParam(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  for (const key of PATH_PARAM_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** Minimal YAML frontmatter reader - only extracts the `name:` field, which is all a
 * SKILL.md's declared skill name needs. Not a general YAML parser. */
function parseFrontmatterName(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const lines = trimmed.split("\n");
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return null;
  for (const line of lines.slice(1, end)) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    if (key !== "name") continue;
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    return value || null;
  }
  return null;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type SkillUsageEventRecord = {
  observedAt: string;
  skillId: string;
  skillName: string;
};

function dayFilePath(skillLogDir: string, date: Date): string {
  return join(skillLogDir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** Registers the after_tool_call detector and appends one JSONL line per detected skill use
 * to `<skillLogDir>/<date>.jsonl`. Unlike the raw LLM archive, this needs no operator opt-in
 * (`before_tool_call`/`after_tool_call` aren't gated by `hooks.allowConversationAccess`) and
 * has no config toggle - it's a core metric, on the same footing as tool/error counts. */
export function registerSkillCapture(
  api: { on: (name: string, handler: (event: any, ctx?: HookAgentContext) => void, opts?: { priority?: number }) => void },
  skillLogDir: string,
  logger: PluginLogger,
): void {
  api.on(
    "after_tool_call",
    (event: any, _ctx?: HookAgentContext) => {
      const toolName = event?.toolName;
      if (!toolName || !READ_TOOL_NAMES.has(toolName) || event?.error) return;

      const pathValue = extractPathParam(event?.params);
      if (!pathValue) return;
      const normalizedPath = pathValue.replace(/\\/g, "/");
      if (basename(normalizedPath) !== "SKILL.md") return;

      const declaredName = parseFrontmatterName(extractResultText(event?.result));
      const fallbackName = basename(dirname(normalizedPath));
      const skillName = declaredName ?? fallbackName;
      const skillId = slugify(skillName) || slugify(fallbackName) || "unknown-skill";

      const record: SkillUsageEventRecord = { observedAt: new Date().toISOString(), skillId, skillName };
      const filePath = dayFilePath(skillLogDir, new Date());
      const line = `${JSON.stringify(record)}\n`;

      mkdir(skillLogDir, { recursive: true })
        .then(() => appendFile(filePath, line, "utf-8"))
        .catch((err) => logger.warn(`[probe] failed to write skill usage log: ${String(err)}`));
    },
    { priority: 50 },
  );

  logger.info(`[probe] skill usage detection armed -> ${skillLogDir}`);
}

/** Windowed skill usage counts from probe's own log, filtered by `observedAt`. Always
 * returns an object (never null) - a missing/empty log directory just means no skill use has
 * been observed yet, not "unavailable". Works the same for start/stop and historical date
 * ranges, since events carry their own timestamp rather than being a cumulative counter. */
export async function collectSkillUsage(
  skillLogDir: string,
  tsStartMs: number,
  tsEndMs: number,
): Promise<Record<string, SkillUsageEntry>> {
  let files: string[];
  try {
    files = (await readdir(skillLogDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return {};
  }

  const counts = new Map<string, SkillUsageEntry>();
  for (const file of files) {
    const text = await readFile(join(skillLogDir, file), "utf-8").catch(() => "");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: SkillUsageEventRecord;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const observedMs = Date.parse(event.observedAt);
      if (!Number.isFinite(observedMs) || observedMs < tsStartMs || observedMs > tsEndMs) continue;
      const entry = counts.get(event.skillId) ?? { name: event.skillName, uses: 0 };
      entry.uses += 1;
      counts.set(event.skillId, entry);
    }
  }
  return Object.fromEntries(counts);
}
