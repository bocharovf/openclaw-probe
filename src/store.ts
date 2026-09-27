import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbePaths } from "./paths.js";
import type { ProbeDiffReport, ProbeMode, ProbeReport } from "./types.js";

export type ActiveMarker = {
  name: string;
  slug: string;
  ts_start_ms: number;
  ts_start_iso: string;
};

export async function readActiveMarker(paths: ProbePaths): Promise<ActiveMarker | null> {
  try {
    const text = await readFile(paths.probeActiveMarkerPath, "utf-8");
    return JSON.parse(text) as ActiveMarker;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeActiveMarker(paths: ProbePaths, marker: ActiveMarker): Promise<void> {
  await mkdir(paths.probeStateDir, { recursive: true });
  await writeFile(paths.probeActiveMarkerPath, JSON.stringify(marker, null, 2), "utf-8");
}

export async function clearActiveMarker(paths: ProbePaths): Promise<void> {
  await rm(paths.probeActiveMarkerPath, { force: true });
}

function resultPath(paths: ProbePaths, slug: string): string {
  return join(paths.probeResultsDir, `${slug}.json`);
}

export function rawRequestsPath(paths: ProbePaths, slug: string): string {
  return join(paths.probeResultsDir, `${slug}.rawrequests.jsonl`);
}

export function memorySearchResultsPath(paths: ProbePaths, slug: string): string {
  return join(paths.probeResultsDir, `${slug}.memory-search.jsonl`);
}

/** Path of a `/probe explain` report, named by the slugified root sessionKey (not a measurement
 * slug - explain operates on a session, not a saved measurement, see commands.ts). */
export function explainResultPath(paths: ProbePaths, slug: string): string {
  return join(paths.probeResultsDir, `${slug}.explain.html`);
}

export async function writeExplainResult(paths: ProbePaths, slug: string, html: string): Promise<string> {
  await mkdir(paths.probeResultsDir, { recursive: true });
  const path = explainResultPath(paths, slug);
  await writeFile(path, html, "utf-8");
  return path;
}

export async function readExplainResult(paths: ProbePaths, slug: string): Promise<string | null> {
  try {
    return await readFile(explainResultPath(paths, slug), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** OpenClaw's own preferred shared temp root - confirmed by reading the host's compiled
 * source (`POSIX_OPENCLAW_TMP_DIR` in its `tmp-openclaw-dir` module), not part of any
 * exported plugin API. A command reply's `mediaUrl` is only accepted for a local `text/html`
 * file when the file's real path resolves inside this directory - live-confirmed: pointing
 * `mediaUrl` at the durable copy in `probeResultsDir` instead was rejected with
 * `LocalMediaAccessError: "hostReadCapability permits only validated plain-text documents and
 * trusted generated HTML reports for local reads"`. This constant could change in a future
 * OpenClaw release; if it does, `writeExplainMediaCopy` below just fails closed (returns
 * null) and `/probe explain` degrades to a text-only reply instead of crashing - see its
 * try/catch and commands.ts's handling of a null return. */
const OPENCLAW_TRUSTED_TMP_DIR = "/tmp/openclaw";

/** Writes a second, disposable copy of an already-generated explain report into OpenClaw's
 * own trusted temp directory (see `OPENCLAW_TRUSTED_TMP_DIR`) purely so a command reply's
 * `mediaUrl` is accepted as a real file attachment - the durable copy stays in
 * `probeResultsDir` via `writeExplainResult`, this one is safe to lose on reboot/cleanup.
 * Returns null on any failure (permissions, disk, host changed the trusted path, ...) so
 * callers can fall back to a text-only reply instead of throwing. */
export async function writeExplainMediaCopy(
  slug: string,
  html: string,
  trustedTmpDir: string = OPENCLAW_TRUSTED_TMP_DIR,
): Promise<string | null> {
  try {
    const dir = join(trustedTmpDir, "probe-explain");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${slug}.explain.html`);
    await writeFile(path, html, "utf-8");
    return path;
  } catch {
    return null;
  }
}

export async function readResult(paths: ProbePaths, slug: string): Promise<ProbeReport | null> {
  try {
    const text = await readFile(resultPath(paths, slug), "utf-8");
    return JSON.parse(text) as ProbeReport;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeResult(paths: ProbePaths, slug: string, report: ProbeReport): Promise<string> {
  await mkdir(paths.probeResultsDir, { recursive: true });
  const path = resultPath(paths, slug);
  await writeFile(path, JSON.stringify(report, null, 2), "utf-8");
  return path;
}

/** Deletes a saved measurement's report and its raw-requests/memory-search sidecars (if any).
 * Returns false without deleting anything if no report exists under that slug - callers use
 * this to decide whether to show a "not found" error, so a missing sidecar alone must not
 * count as absent. */
export async function deleteResult(paths: ProbePaths, slug: string): Promise<boolean> {
  const existed = (await readResult(paths, slug)) !== null;
  if (!existed) return false;
  await rm(resultPath(paths, slug), { force: true });
  await rm(rawRequestsPath(paths, slug), { force: true });
  await rm(memorySearchResultsPath(paths, slug), { force: true });
  return true;
}

/** Path of a saved diff report between two measurements, named `<slug1>.<slug2>.diff.json`
 * (slugified, not the raw names, so it stays filesystem-safe) in the same directory as the
 * measurements it compares. */
export function diffResultPath(paths: ProbePaths, slug1: string, slug2: string): string {
  return join(paths.probeResultsDir, `${slug1}.${slug2}.diff.json`);
}

export async function writeDiffResult(
  paths: ProbePaths,
  slug1: string,
  slug2: string,
  diff: ProbeDiffReport,
): Promise<string> {
  await mkdir(paths.probeResultsDir, { recursive: true });
  const path = diffResultPath(paths, slug1, slug2);
  await writeFile(path, JSON.stringify(diff, null, 2), "utf-8");
  return path;
}

export type ResultSummary = {
  name: string;
  slug: string;
  mode: ProbeMode;
  generatedAt: string;
};

/** Lists saved measurements, newest first (by `probe.generated_at`), capped at `limit`.
 * `total` is the count of all readable saved reports, so callers can tell "showing 50 of 50"
 * apart from "showing 50 of 214". Corrupt/unreadable result files are skipped rather than
 * failing the whole listing - `.rawrequests.jsonl` sidecars and `.diff.json` comparison
 * reports (see `diffResultPath`) are excluded explicitly, not by any incidental parse failure. */
export async function listResults(paths: ProbePaths, limit: number): Promise<{ summaries: ResultSummary[]; total: number }> {
  let files: string[];
  try {
    files = await readdir(paths.probeResultsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { summaries: [], total: 0 };
    throw err;
  }

  const all: ResultSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".diff.json")) continue;
    try {
      const text = await readFile(join(paths.probeResultsDir, file), "utf-8");
      const report = JSON.parse(text) as ProbeReport;
      all.push({
        name: report.probe.name,
        slug: file.slice(0, -".json".length),
        mode: report.probe.mode,
        generatedAt: report.probe.generated_at,
      });
    } catch {
      // skip unreadable/corrupt result files rather than failing the whole listing
    }
  }

  all.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  return { summaries: all.slice(0, limit), total: all.length };
}
