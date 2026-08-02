import { buildReport } from "./report.js";
import type { ProbePaths } from "./paths.js";
import { slugify } from "./paths.js";
import { clearActiveMarker, readActiveMarker, readResult, writeActiveMarker, writeResult } from "./store.js";
import { formatVerboseReport } from "./format.js";
import { ProbeUserError, type PluginLogger, type ProbeConfig } from "./types.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RESERVED_NAMES = new Set(["start", "stop", "verbose"]);

const HELP_TEXT = [
  "Probe - agent run cost/speed/behavior measurement.",
  "",
  "Commands:",
  "  /probe start <name>              start a named measurement",
  "  /probe stop                      stop the active measurement and save its report",
  "  /probe <start-ts> <end-ts>       build a measurement for a past time range",
  "                                    (ISO 8601, e.g. 2026-08-01T00:00:00Z)",
  "  /probe <name>                    show a saved measurement as JSON",
  "  /probe verbose <name>            show a saved measurement as an annotated report",
  "",
  "A probe name cannot be \"start\", \"stop\", \"verbose\", or look like two timestamps.",
  "Only one `start`ed measurement can be active at a time.",
].join("\n");

type Command =
  | { type: "help" }
  | { type: "start"; name: string }
  | { type: "stop" }
  | { type: "range"; startIso: string; endIso: string }
  | { type: "show"; name: string }
  | { type: "verbose"; name: string }
  | { type: "error"; message: string };

export function parseProbeArgs(raw: string): Command {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { type: "help" };

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0].toLowerCase();

  if (head === "start") {
    const name = tokens.slice(1).join(" ").trim();
    if (!name) return { type: "error", message: "Provide a name: `/probe start <name>`." };
    const nameError = validateProbeName(name);
    if (nameError) return { type: "error", message: nameError };
    return { type: "start", name };
  }

  if (head === "stop") {
    if (tokens.length > 1) {
      return { type: "error", message: "`/probe stop` takes no arguments. Did you mean `/probe stop`?" };
    }
    return { type: "stop" };
  }

  if (head === "verbose") {
    const name = tokens.slice(1).join(" ").trim();
    if (!name) return { type: "error", message: "Provide a name: `/probe verbose <name>`." };
    return { type: "verbose", name };
  }

  if (tokens.length === 2 && ISO_RE.test(tokens[0]) && ISO_RE.test(tokens[1])) {
    return { type: "range", startIso: tokens[0], endIso: tokens[1] };
  }

  return { type: "show", name: trimmed };
}

function validateProbeName(name: string): string | null {
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return `"${name}" is a reserved word and cannot be used as a probe name (start/stop/verbose).`;
  }
  const tokens = name.split(/\s+/);
  if (tokens.length === 2 && ISO_RE.test(tokens[0]) && ISO_RE.test(tokens[1])) {
    return `"${name}" looks like a time range, not a name - choose a name that isn't two ISO 8601 timestamps.`;
  }
  return null;
}

function rangeSlug(startMs: number, endMs: number): string {
  const compact = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `range-${compact(startMs)}-${compact(endMs)}`;
}

export type CommandDeps = {
  config: ProbeConfig;
  paths: ProbePaths;
  logger: PluginLogger;
};

export async function runProbeCommand(raw: string, deps: CommandDeps): Promise<string> {
  const cmd = parseProbeArgs(raw);

  switch (cmd.type) {
    case "help":
      return HELP_TEXT;

    case "error":
      return `${cmd.message}\n\n${HELP_TEXT}`;

    case "start":
      return handleStart(cmd.name, deps);

    case "stop":
      return handleStop(deps);

    case "range":
      return handleRange(cmd.startIso, cmd.endIso, deps);

    case "show":
      return handleShow(cmd.name, deps);

    case "verbose":
      return handleVerbose(cmd.name, deps);
  }
}

async function handleStart(name: string, { paths }: CommandDeps): Promise<string> {
  const active = await readActiveMarker(paths);
  if (active) {
    throw new ProbeUserError(
      `A measurement is already active: "${active.name}" (started ${active.ts_start_iso}). ` +
        `Run \`/probe stop\` first, or wait for it to finish before starting a new one.`,
    );
  }
  const tsStartMs = Date.now();
  await writeActiveMarker(paths, {
    name,
    slug: slugify(name),
    ts_start_ms: tsStartMs,
    ts_start_iso: new Date(tsStartMs).toISOString(),
  });
  return `Started measurement "${name}" at ${new Date(tsStartMs).toISOString()}. Run \`/probe stop\` when done.`;
}

async function handleStop(deps: CommandDeps): Promise<string> {
  const active = await readActiveMarker(deps.paths);
  if (!active) {
    throw new ProbeUserError('No active measurement to stop. Start one first with `/probe start <name>`.');
  }

  const tsEndMs = Date.now();
  const { report } = await buildReport({
    config: deps.config,
    paths: deps.paths,
    name: active.name,
    slug: active.slug,
    mode: "start-stop",
    tsStartMs: active.ts_start_ms,
    tsEndMs,
  });
  await writeResult(deps.paths, active.slug, report);
  await clearActiveMarker(deps.paths);

  const t = report.tokens;
  const summary = [
    `Stopped measurement "${active.name}".`,
    `Wall clock: ${report.window.wall_clock_sec}s | agent active: ${report.time.agent_active_sec}s | LLM calls: ${report.iterations.llm_calls} | tool calls: ${report.iterations.tool_calls_total} | tokens total: ${t.total ?? 0}`,
    report.warnings.length ? `Warnings: ${report.warnings.join("; ")}` : undefined,
    `Full report: \`/probe ${active.name}\` (JSON) or \`/probe verbose ${active.name}\` (annotated).`,
  ]
    .filter(Boolean)
    .join("\n");
  return summary;
}

async function handleRange(startIso: string, endIso: string, deps: CommandDeps): Promise<string> {
  const tsStartMs = Date.parse(startIso);
  const tsEndMs = Date.parse(endIso);
  if (!Number.isFinite(tsStartMs) || !Number.isFinite(tsEndMs)) {
    throw new ProbeUserError(`Could not parse one of the timestamps: "${startIso}" / "${endIso}".`);
  }
  if (tsStartMs >= tsEndMs) {
    throw new ProbeUserError(
      `Invalid range: start (${startIso}) must be strictly before end (${endIso}).`,
    );
  }

  const slug = rangeSlug(tsStartMs, tsEndMs);
  const name = `${startIso} .. ${endIso}`;
  const { report, hasAnyAuditEvents } = await buildReport({
    config: deps.config,
    paths: deps.paths,
    name,
    slug,
    mode: "range",
    tsStartMs,
    tsEndMs,
  });

  if (!hasAnyAuditEvents) {
    throw new ProbeUserError(
      `No data found for ${startIso} .. ${endIso}. The audit ledger only retains 30 days of ` +
        `history and is capped at 100,000 rows, so older or out-of-range windows return nothing. ` +
        `Double-check the range, or that this Gateway was running and \`audit.enabled\` during it.`,
    );
  }

  await writeResult(deps.paths, slug, report);
  return [
    `Measurement "${name}" saved.`,
    `Retrieve it later with \`/probe ${name}\` or \`/probe verbose ${name}\`.`,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
  ].join("\n");
}

async function handleShow(name: string, deps: CommandDeps): Promise<string> {
  const report = await readResult(deps.paths, slugify(name));
  if (!report) {
    throw new ProbeUserError(
      `No measurement named "${name}" was found. Names are case-sensitive as given to ` +
        `\`/probe start\`, or the exact "<start> .. <end>" range you requested earlier.`,
    );
  }
  return ["```json", JSON.stringify(report, null, 2), "```"].join("\n");
}

async function handleVerbose(name: string, deps: CommandDeps): Promise<string> {
  const report = await readResult(deps.paths, slugify(name));
  if (!report) {
    throw new ProbeUserError(
      `No measurement named "${name}" was found. Names are case-sensitive as given to ` +
        `\`/probe start\`, or the exact "<start> .. <end>" range you requested earlier.`,
    );
  }
  return formatVerboseReport(report);
}
