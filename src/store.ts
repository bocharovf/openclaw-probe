import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbePaths } from "./paths.js";
import type { ProbeReport } from "./types.js";

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
