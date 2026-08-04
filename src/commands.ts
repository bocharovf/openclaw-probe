import { buildDiff } from "./diff.js";
import { buildReport } from "./report.js";
import type { ProbePaths } from "./paths.js";
import { slugify } from "./paths.js";
import {
  clearActiveMarker,
  deleteResult,
  diffResultPath,
  listResults,
  readActiveMarker,
  readResult,
  writeActiveMarker,
  writeDiffResult,
  writeResult,
} from "./store.js";
import { formatVerboseDiff, formatVerboseReport } from "./format.js";
import { ProbeUserError, type PluginLogger, type ProbeConfig, type ProbeReport } from "./types.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RESERVED_NAMES = new Set(["start", "stop", "verbose", "list", "delete", "diff"]);
const LIST_LIMIT = 50;
const REQUIRED_REPORT_FIELDS = [
  "probe",
  "window",
  "sessions",
  "time",
  "iterations",
  "models_used",
  "tokens",
  "context",
  "tools_used",
  "plugins_used",
  "skills_used",
  "errors",
  "llm_api_log",
  "events",
  "warnings",
] as const;

const HELP_TEXT = [
  "Probe - agent run cost/speed/behavior measurement.",
  "",
  "Commands:",
  "  /probe start <name>                     start a named measurement",
  "  /probe stop                             stop the active measurement and save its report",
  "  /probe <start-ts> <end-ts> [name]        build a measurement for a past time range",
  "                                            (ISO 8601, e.g. 2026-08-01T00:00:00Z). Name",
  "                                            defaults to \"<start-ts> .. <end-ts>\" if omitted.",
  "  /probe <name>                           show a saved measurement as JSON",
  "  /probe verbose <name>                   show a saved measurement as an annotated report",
  `  /probe list                             list the last ${LIST_LIMIT} saved measurements, newest first`,
  "  /probe delete <name>                    delete a saved measurement",
  "  /probe diff <name1>, <name2>            compare two saved measurements as JSON",
  "  /probe diff verbose <name1>, <name2>    compare two saved measurements as an annotated report",
  "                                            (separate the two names with a comma). Every numeric",
  "                                            field's value is name2 minus name1; every used-tool/",
  "                                            plugin/skill/model/event/etc list is a set difference",
  "                                            name2-name1, shown as \"+added\" / \"-removed\". The diff",
  "                                            is also saved as <name1>.<name2>.diff.json.",
  "",
  "A probe name cannot be \"start\", \"stop\", \"verbose\", \"list\", \"delete\", or \"diff\", or look like",
  "two timestamps. Only one `start`ed measurement can be active at a time.",
].join("\n");

type Command =
  | { type: "help" }
  | { type: "start"; name: string }
  | { type: "stop" }
  | { type: "range"; startIso: string; endIso: string; name?: string }
  | { type: "show"; name: string }
  | { type: "verbose"; name: string }
  | { type: "list" }
  | { type: "delete"; name: string }
  | { type: "diff"; name1: string; name2: string; verbose: boolean }
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

  if (head === "list") {
    if (tokens.length > 1) {
      return { type: "error", message: "`/probe list` takes no arguments. Did you mean `/probe list`?" };
    }
    return { type: "list" };
  }

  if (head === "delete") {
    const name = tokens.slice(1).join(" ").trim();
    if (!name) return { type: "error", message: "Provide a name: `/probe delete <name>`." };
    return { type: "delete", name };
  }

  if (head === "diff") {
    const rest = tokens.slice(1);
    const verbose = rest[0]?.toLowerCase() === "verbose";
    const body = (verbose ? rest.slice(1) : rest).join(" ").trim();
    const usage = verbose ? "`/probe diff verbose <name1>, <name2>`" : "`/probe diff <name1>, <name2>`";
    if (!body) return { type: "error", message: `Provide two names, separated by a comma: ${usage}.` };
    const commaIdx = body.indexOf(",");
    if (commaIdx === -1) {
      return { type: "error", message: `Separate the two names with a comma: ${usage}.` };
    }
    const name1 = body.slice(0, commaIdx).trim();
    const name2 = body.slice(commaIdx + 1).trim();
    if (!name1 || !name2) {
      return { type: "error", message: `Both names must be non-empty: ${usage}.` };
    }
    return { type: "diff", name1, name2, verbose };
  }

  if (tokens.length >= 2 && ISO_RE.test(tokens[0]) && ISO_RE.test(tokens[1])) {
    const name = tokens.slice(2).join(" ").trim();
    if (!name) return { type: "range", startIso: tokens[0], endIso: tokens[1] };
    const nameError = validateProbeName(name);
    if (nameError) return { type: "error", message: nameError };
    return { type: "range", startIso: tokens[0], endIso: tokens[1], name };
  }

  return { type: "show", name: trimmed };
}

function validateProbeName(name: string): string | null {
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return `"${name}" is a reserved word and cannot be used as a probe name (start/stop/verbose/list/delete).`;
  }
  const tokens = name.split(/\s+/);
  if (tokens.length === 2 && ISO_RE.test(tokens[0]) && ISO_RE.test(tokens[1])) {
    return `"${name}" looks like a time range, not a name - choose a name that isn't two ISO 8601 timestamps.`;
  }
  return null;
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
      return handleRange(cmd.startIso, cmd.endIso, cmd.name, deps);

    case "show":
      return handleShow(cmd.name, deps);

    case "verbose":
      return handleVerbose(cmd.name, deps);

    case "list":
      return handleList(deps);

    case "delete":
      return handleDelete(cmd.name, deps);

    case "diff":
      return handleDiff(cmd.name1, cmd.name2, cmd.verbose, deps);
  }
}

function notFoundError(name: string): ProbeUserError {
  return new ProbeUserError(
    `No measurement named "${name}" was found. Matching is case-insensitive but otherwise ` +
      `exact - use the name given to \`/probe start\`/\`/probe <start> <end> [name]\`, or the ` +
      `auto-generated "<start> .. <end>" if no name was given for a range measurement.`,
  );
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

async function handleRange(
  startIso: string,
  endIso: string,
  customName: string | undefined,
  deps: CommandDeps,
): Promise<string> {
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

  // The slug used to save a report must be the exact same function used to look one up
  // (handleShow/handleVerbose both do slugify(name)) - otherwise a saved range report can
  // become unreachable by name, which is what happened before this used a separate
  // timestamp-derived slug here.
  const name = customName ?? `${startIso} .. ${endIso}`;
  const slug = slugify(name);
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
  if (!report) throw notFoundError(name);
  return ["```json", JSON.stringify(report, null, 2), "```"].join("\n");
}

async function handleVerbose(name: string, deps: CommandDeps): Promise<string> {
  const report = await readResult(deps.paths, slugify(name));
  if (!report) throw notFoundError(name);
  return formatVerboseReport(report);
}

async function handleList(deps: CommandDeps): Promise<string> {
  const { summaries, total } = await listResults(deps.paths, LIST_LIMIT);
  if (total === 0) {
    return (
      "No saved measurements yet. Start one with `/probe start <name>`, or build one for a " +
      "past time range with `/probe <start> <end> [name]`."
    );
  }

  const lines = summaries.map((r, i) => `${i + 1}. ${r.generatedAt}  "${r.name}"  (${r.mode})`);
  const header =
    total > summaries.length
      ? `Newest ${summaries.length} of ${total} saved measurements:`
      : `${total} saved measurement${total === 1 ? "" : "s"}, newest first:`;
  return [header, ...lines].join("\n");
}

async function handleDelete(name: string, deps: CommandDeps): Promise<string> {
  const deleted = await deleteResult(deps.paths, slugify(name));
  if (!deleted) throw notFoundError(name);
  return `Deleted measurement "${name}".`;
}

/** Loads a saved measurement for `/probe diff`, converting both "no such name" and "the file
 * exists but isn't a usable report" (corrupt JSON, or valid JSON missing the fields a report
 * must have - e.g. hand-edited or from an incompatible probe version) into a friendly
 * `ProbeUserError` instead of a raw parse/type-error crash. */
async function readResultForDiff(name: string, slug: string, deps: CommandDeps): Promise<ProbeReport> {
  let report: ProbeReport | null;
  try {
    report = await readResult(deps.paths, slug);
  } catch (err) {
    throw new ProbeUserError(
      `Measurement "${name}" (${slug}.json) could not be read as JSON and cannot be diffed - ` +
        `the file may be corrupted: ${(err as Error).message}`,
    );
  }
  if (!report) throw notFoundError(name);

  for (const field of REQUIRED_REPORT_FIELDS) {
    if (!(field in report)) {
      throw new ProbeUserError(
        `Measurement "${name}" (${slug}.json) is missing the expected field "${field}" and ` +
          `cannot be diffed - the file may be corrupted or from an incompatible probe version.`,
      );
    }
  }
  return report;
}

async function handleDiff(name1: string, name2: string, verbose: boolean, deps: CommandDeps): Promise<string> {
  const slug1 = slugify(name1);
  const slug2 = slugify(name2);
  const report1 = await readResultForDiff(name1, slug1, deps);
  const report2 = await readResultForDiff(name2, slug2, deps);

  const resultFile = diffResultPath(deps.paths, slug1, slug2);
  const diffReport = buildDiff(name1, slug1, report1, name2, slug2, report2, resultFile);
  await writeDiffResult(deps.paths, slug1, slug2, diffReport);

  if (verbose) return formatVerboseDiff(diffReport);

  return [
    `Diff "${name1}" -> "${name2}" saved to ${resultFile}.`,
    "",
    "```json",
    JSON.stringify(diffReport, null, 2),
    "```",
  ].join("\n");
}
