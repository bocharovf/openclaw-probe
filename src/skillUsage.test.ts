import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSkillUsage, registerSkillCapture } from "./skillUsage.js";

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("registerSkillCapture", () => {
  let skillLogDir: string;
  let handlers: Record<string, (event: any, ctx?: any) => void>;
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(async () => {
    skillLogDir = join(await mkdtemp(join(tmpdir(), "probe-skilllog-")), "skill-usage");
    handlers = {};
    const api = {
      on: (name: string, handler: (event: any, ctx?: any) => void) => {
        handlers[name] = handler;
      },
    };
    registerSkillCapture(api, skillLogDir, logger);
  });

  afterEach(async () => {
    await rm(skillLogDir, { recursive: true, force: true });
  });

  it("detects a SKILL.md read and records the declared frontmatter name", async () => {
    handlers.after_tool_call({
      toolName: "read",
      params: { path: "/root/.openclaw/skills/weather/SKILL.md" },
      result: textResult('---\nname: Weather\ndescription: Get the weather\n---\n\nBody text.'),
    });

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => Object.keys(await collectSkillUsage(skillLogDir, tsStart, tsEnd)).length === 1);

    const usage = await collectSkillUsage(skillLogDir, tsStart, tsEnd);
    expect(usage).toEqual({ weather: { name: "Weather", uses: 1 } });
  });

  it("falls back to the parent directory name when there is no frontmatter name", async () => {
    handlers.after_tool_call({
      toolName: "read",
      params: { path: "/root/.openclaw/skills/aiops-incident/SKILL.md" },
      result: textResult("no frontmatter here"),
    });

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => Object.keys(await collectSkillUsage(skillLogDir, tsStart, tsEnd)).length === 1);

    const usage = await collectSkillUsage(skillLogDir, tsStart, tsEnd);
    expect(usage).toEqual({ "aiops-incident": { name: "aiops-incident", uses: 1 } });
  });

  it("ignores non-read tool calls", async () => {
    handlers.after_tool_call({ toolName: "exec", params: { command: "ls" }, result: textResult("ok") });
    await new Promise((r) => setTimeout(r, 100));
    expect(await collectSkillUsage(skillLogDir, 0, Date.now() + 1000)).toEqual({});
  });

  it("ignores reads of files that are not SKILL.md", async () => {
    handlers.after_tool_call({
      toolName: "read",
      params: { path: "/root/.openclaw/skills/weather/README.md" },
      result: textResult("---\nname: Weather\n---\n"),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(await collectSkillUsage(skillLogDir, 0, Date.now() + 1000)).toEqual({});
  });

  it("ignores errored reads", async () => {
    handlers.after_tool_call({
      toolName: "read",
      params: { path: "/root/.openclaw/skills/weather/SKILL.md" },
      error: "ENOENT",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(await collectSkillUsage(skillLogDir, 0, Date.now() + 1000)).toEqual({});
  });

  it("recognizes alternate path param names and backslash paths", async () => {
    handlers.after_tool_call({
      toolName: "read_file",
      params: { file_path: "C:\\openclaw\\skills\\weather\\SKILL.md" },
      result: textResult("---\nname: Weather\n---\n"),
    });

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => Object.keys(await collectSkillUsage(skillLogDir, tsStart, tsEnd)).length === 1);
    expect(await collectSkillUsage(skillLogDir, tsStart, tsEnd)).toEqual({ weather: { name: "Weather", uses: 1 } });
  });

  it("counts repeated uses of the same skill", async () => {
    for (let i = 0; i < 3; i++) {
      handlers.after_tool_call({
        toolName: "read",
        params: { path: "/root/.openclaw/skills/weather/SKILL.md" },
        result: textResult("---\nname: Weather\n---\n"),
      });
    }

    const tsStart = Date.now() - 60_000;
    const tsEnd = Date.now() + 60_000;
    await waitFor(async () => (await collectSkillUsage(skillLogDir, tsStart, tsEnd)).weather?.uses === 3);
  });
});

describe("collectSkillUsage", () => {
  let skillLogDir: string;

  beforeEach(async () => {
    skillLogDir = await mkdtemp(join(tmpdir(), "probe-skillcollect-"));
  });

  afterEach(async () => {
    await rm(skillLogDir, { recursive: true, force: true });
  });

  it("returns an empty object when the log directory does not exist", async () => {
    const usage = await collectSkillUsage(join(skillLogDir, "missing"), 0, Date.now());
    expect(usage).toEqual({});
  });

  it("filters events by window", async () => {
    await mkdir(skillLogDir, { recursive: true });
    const lines = [
      { observedAt: "2026-08-01T00:00:00.000Z", skillId: "weather", skillName: "Weather" },
      { observedAt: "2026-08-01T00:05:00.000Z", skillId: "weather", skillName: "Weather" },
      { observedAt: "2026-07-01T00:00:00.000Z", skillId: "weather", skillName: "Weather" }, // outside window
    ];
    await writeFile(join(skillLogDir, "2026-08-01.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const tsStart = Date.parse("2026-08-01T00:00:00.000Z");
    const tsEnd = Date.parse("2026-08-01T01:00:00.000Z");
    expect(await collectSkillUsage(skillLogDir, tsStart, tsEnd)).toEqual({ weather: { name: "Weather", uses: 2 } });
  });

  it("skips unparsable lines instead of throwing", async () => {
    await mkdir(skillLogDir, { recursive: true });
    await writeFile(
      join(skillLogDir, "2026-08-01.jsonl"),
      'not json\n{"observedAt":"2026-08-01T00:00:00.000Z","skillId":"weather","skillName":"Weather"}\n',
    );
    const usage = await collectSkillUsage(skillLogDir, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-01T01:00:00Z"));
    expect(usage).toEqual({ weather: { name: "Weather", uses: 1 } });
  });

  it("aggregates across multiple day files", async () => {
    await mkdir(skillLogDir, { recursive: true });
    await writeFile(
      join(skillLogDir, "2026-08-01.jsonl"),
      JSON.stringify({ observedAt: "2026-08-01T23:00:00.000Z", skillId: "weather", skillName: "Weather" }) + "\n",
    );
    await writeFile(
      join(skillLogDir, "2026-08-02.jsonl"),
      JSON.stringify({ observedAt: "2026-08-02T01:00:00.000Z", skillId: "weather", skillName: "Weather" }) + "\n",
    );
    const usage = await collectSkillUsage(skillLogDir, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-03T00:00:00Z"));
    expect(usage).toEqual({ weather: { name: "Weather", uses: 2 } });
  });
});
