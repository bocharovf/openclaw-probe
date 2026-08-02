import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuditEvent, ProbeConfig } from "./types.js";

const execFileAsync = promisify(execFile);

/** `openclaw` sometimes prints `[plugins]`/`[openclaw]` startup lines to stdout before the
 * JSON payload. The JSON itself is pretty-printed (multi-line), so take everything from the
 * first "{" - those startup lines never start with "{". */
function extractJson(stdout: string): unknown {
  const brace = stdout.indexOf("{");
  if (brace === -1) {
    throw new Error(`openclaw did not return JSON. stdout=${JSON.stringify(stdout.slice(0, 500))}`);
  }
  return JSON.parse(stdout.slice(brace));
}

async function runOpenclaw(config: ProbeConfig, args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(config.openclawBin, args, {
    timeout: config.cliTimeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return extractJson(stdout);
}

/** Paginated `openclaw audit --json --after <ms> --before <ms>` over the full window.
 * Mirrors the audit CLI's own paging contract (newest-first pages, `nextCursor` to continue). */
export async function fetchAuditEvents(
  config: ProbeConfig,
  afterMs: number,
  beforeMs: number,
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const args = [
      "audit",
      "--json",
      "--after",
      String(afterMs),
      "--before",
      String(beforeMs),
      "--limit",
      "500",
    ];
    if (cursor) args.push("--cursor", cursor);
    const page = (await runOpenclaw(config, args)) as { events?: AuditEvent[]; nextCursor?: string };
    const pageEvents = page.events ?? [];
    events.push(...pageEvents);
    const nextCursor = page.nextCursor;
    if (!pageEvents.length || pageEvents.length < 500 || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return events;
}

export type PluginListEntry = {
  id: string;
  status?: string;
  contracts?: { tools?: string[] };
};

/** Builds a tool-name -> owning-plugin-id map from `openclaw plugins list --json`.
 * `contracts.tools` is manifest-declared ownership, available without loading each plugin's
 * runtime (see OpenClaw's building-plugins.md), so this is a single fast call regardless of
 * how many plugins are installed - unlike `plugins inspect --runtime`, which loads every
 * plugin's runtime one at a time and does not scale for a report-generation command. */
export async function fetchToolToPluginMap(config: ProbeConfig): Promise<Map<string, string>> {
  const result = (await runOpenclaw(config, ["plugins", "list", "--json"])) as {
    plugins?: PluginListEntry[];
  };
  const map = new Map<string, string>();
  for (const plugin of result.plugins ?? []) {
    for (const tool of plugin.contracts?.tools ?? []) {
      map.set(tool, plugin.id);
    }
  }
  return map;
}
