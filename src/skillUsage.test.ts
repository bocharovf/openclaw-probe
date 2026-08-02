import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSkillUsage } from "./skillUsage.js";

describe("collectSkillUsage", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "probe-skills-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns null when the skill-usage plugin's event log is missing", async () => {
    const result = await collectSkillUsage(baseDir, 0, Date.now());
    expect(result).toBeNull();
  });

  it("counts only events inside the window", async () => {
    const dir = join(baseDir, "state", "plugins", "skill-usage", "events");
    await mkdir(dir, { recursive: true });
    const lines = [
      { observedAt: "2026-08-01T00:00:00.000Z", skillId: "weather", skillName: "weather" },
      { observedAt: "2026-08-01T00:05:00.000Z", skillId: "weather", skillName: "weather" },
      { observedAt: "2026-08-01T01:00:00.000Z", skillId: "aiops-incident", skillName: "aiops-incident" },
      { observedAt: "2026-07-01T00:00:00.000Z", skillId: "weather", skillName: "weather" }, // outside window
    ];
    await writeFile(join(dir, "skill-usage-events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const tsStart = Date.parse("2026-08-01T00:00:00.000Z");
    const tsEnd = Date.parse("2026-08-01T02:00:00.000Z");
    const result = await collectSkillUsage(baseDir, tsStart, tsEnd);

    expect(result).toEqual({
      weather: { name: "weather", uses: 2 },
      "aiops-incident": { name: "aiops-incident", uses: 1 },
    });
  });

  it("skips unparsable lines instead of throwing", async () => {
    const dir = join(baseDir, "state", "plugins", "skill-usage", "events");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "skill-usage-events.jsonl"),
      'not json\n{"observedAt":"2026-08-01T00:00:00.000Z","skillId":"weather","skillName":"weather"}\n',
    );

    const result = await collectSkillUsage(baseDir, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-01T01:00:00Z"));
    expect(result).toEqual({ weather: { name: "weather", uses: 1 } });
  });
});
