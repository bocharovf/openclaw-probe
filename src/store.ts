import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbePaths } from "./paths.js";
import type { ProbeMode, ProbeReport } from "./types.js";

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

export type ResultSummary = {
  name: string;
  slug: string;
  mode: ProbeMode;
  generatedAt: string;
};

/** Lists saved measurements, newest first (by `probe.generated_at`), capped at `limit`.
 * `total` is the count of all readable saved reports, so callers can tell "showing 50 of 50"
 * apart from "showing 50 of 214". Corrupt/unreadable result files are skipped rather than
 * failing the whole listing - `.rawrequests.jsonl` sidecars are excluded by the `.json`
 * extension filter, not by any name-based guess. */
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
    if (!file.endsWith(".json")) continue;
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
