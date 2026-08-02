# Probe

An [OpenClaw](https://openclaw.ai) plugin that measures **agent run cost, speed, and
behavior over a time window** - wall-clock/LLM/tool time, token usage, tool and skill
usage, error counts, and (optionally) a full raw LLM request/response archive.

It exists to answer one question repeatedly and consistently: *did this change (a new
skill, a prompt tweak, a different model, a new tool plugin) make the agent cheaper,
faster, or more/less reliable?* Run the same task with `/probe start` / `/probe stop`
bracketing it, make your change, run it again, and diff the two JSON reports.

Probe is self-contained: it captures its own LLM request/response data via hooks and does
**not** depend on the `llm-api-logger` plugin or any other plugin being installed. Its core
numeric metrics (time, tokens, tool/skill usage, errors) come from OpenClaw's own audit
ledger and trajectory files and work regardless of what else is installed.

## Install

```bash
openclaw plugins install clawhub:<org>/probe
```

or, from a local checkout:

```bash
npm install
npm run build
openclaw plugins install . --force
```

## Requirements

Probe reads from several OpenClaw subsystems (chat commands, the audit ledger, trajectory
files, the `skill-usage` plugin, its own hooks). Each has its own config gate. This section
lists what has to be true on the host for `/probe` to work at all, and separately, what each
*optional* piece of the report additionally needs - so a report that is missing a field is
easy to diagnose instead of looking like a bug.

### Required - without these, `/probe` does not run at all

| Setting | Needed because | Symptom if missing/wrong |
| --- | --- | --- |
| `plugins.allow` includes `"probe"` | Plugin must be allowlisted to load. | Plugin never loads; no `/probe` command exists. |
| `plugins.entries.probe.enabled: true` | Explicit enable (set automatically by `openclaw plugins install`). | Same as above. |
| `commands.text` is not `false` (default `true`) | `/...` chat commands are only parsed when text-command parsing is on. | `/probe ...` is treated as a normal chat message and goes to the model instead of the plugin (it will typically reply something like it doesn't recognize the command, or - if you've added the `agentPromptGuidance` this plugin ships - decline to answer). |
| The sender is authorized | The command sets `requireAuth: true` (default for chat commands). Authorization comes from `commands.allowFrom`, or otherwise from channel allowlists/pairing plus `commands.useAccessGroups`. | Unauthorized senders get no response; the command is silently ignored. |
| `openclaw` is reachable in `PATH` for the Gateway process | Probe shells out to `openclaw audit --json` and `openclaw plugins list --json` for every report (see [Data sources](#data-sources)). | `/probe stop` / `/probe <range>` fails with a "Probe command failed" error instead of a report. Point `plugins.entries.probe.config.openclawBin` at an explicit path if `openclaw` isn't on the Gateway's `PATH`. |

### Required for the core metrics (time, tokens, tool/skill usage, errors)

| Setting | Needed because | Symptom if missing/wrong |
| --- | --- | --- |
| `audit.enabled` is not `false` (default `true`) | `time`, `iterations`, `errors`, `sessions`, and `tools_used` all come from the audit ledger - there is no other source for them. | Every report has zeroed-out `time`/`iterations`/`errors`, empty `sessions`/`tools_used`, and `/probe <start> <end>` for that window fails with the "No data found" error (see [Error messages](#error-messages)). `/probe start`/`stop` still "succeeds" but the report is empty. |
| The probed window is inside the audit ledger's retention (**30 days / 100,000 rows**, not configurable) | Older records are pruned; there's nothing to read. | Same "No data found" error for `/probe <start> <end>` on an old range. Always use `/probe start`/`stop` for anything you want reliably measured, and treat `/probe <start> <end>` as best-effort for anything more than a few days old. |
| Trajectory sidecar files for the involved runs still exist on disk (written automatically, no on/off switch - but `session.maintenance` can prune old ones as part of its retention/disk-budget cleanup) | `tokens`, `models_used`, `context`, and `llm_calls`/`tool_calling_rounds` come from each run's `<agent>/sessions/<session>.trajectory.jsonl`. | Those fields undercount or stay at `0` for the affected runs, and the report's `warnings` array names the run id it couldn't find a trajectory for. `time`/`iterations`/`errors`/`tools_used` are unaffected (audit-ledger-only). |

### Optional - `skills_used`

| Setting | Needed because | Symptom if missing/wrong |
| --- | --- | --- |
| The bundled `skill-usage` plugin is installed and enabled (`plugins.allow` includes `"skill-usage"`, `plugins.entries.skill-usage.enabled: true`) | `skills_used` is read from that plugin's own event log; probe does not track skill usage itself. | `skills_used` is `null` (not `{}` - distinguishable from "present but zero uses") and a note appears in `warnings`. Every other field is unaffected. |

### Optional - raw LLM request/response archive (`llm_api_log`)

| Setting | Needed because | Symptom if missing/wrong |
| --- | --- | --- |
| `plugins.entries.probe.hooks.allowConversationAccess: true` | OpenClaw gates the `llm_input`/`llm_output` hooks behind an explicit opt-in for any plugin that isn't bundled with OpenClaw itself - without it, the host simply never invokes them. | `llm_api_log.entries_captured` is always `0` and `.file` is always `null`. Nothing else in the report is affected. |
| `plugins.entries.probe.config.llmLog.enabled` is not `false` (default `true`) | Plugin-side switch for the same capture. | Same as above. |

```json5
{
  "plugins": {
    "entries": {
      "probe": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

None of the optional items above affect whether `/probe` runs or whether the core metrics
(time, tokens, tool/skill usage, errors) are correct - they only control whether one
specific field is populated or falls back to `null`/`0`/an empty object, always with a
matching note in the report's `warnings` array.

## Commands

| Command | Description |
| --- | --- |
| `/probe start <name>` | Start a named measurement. Fails if one is already active. |
| `/probe stop` | Stop the active measurement, compute its report, and save it. Fails if none is active. |
| `/probe <start> <end>` | Build (and save) a measurement for a past time range. Timestamps are ISO 8601, e.g. `2026-08-01T00:00:00Z`. |
| `/probe <name>` | Print a saved measurement's report as JSON. |
| `/probe verbose <name>` | Print a saved measurement's report as an annotated, human-readable text report explaining every field. |
| `/probe` (no args) | Print this command summary. |

Only **one** `start`ed measurement can be active at a time - `/probe start` while one is
already running is rejected, and you must `/probe stop` (or let it finish) before starting
another.

A probe name cannot be exactly `start`, `stop`, or `verbose` (reserved words), and cannot be
two ISO 8601 timestamps separated by whitespace (that parses as a range request instead).
Names may contain spaces, e.g. `/probe start baseline before cache change`.

### Examples

```text
/probe start baseline
... run the task you want to measure ...
/probe stop
/probe baseline
/probe verbose baseline

/probe 2026-08-01T00:00:00Z 2026-08-01T06:00:00Z
```

### Error messages

Probe rejects the following with a clear, non-technical message instead of a stack trace or
silent wrong answer:

- Starting a measurement while one is already active.
- Stopping when no measurement is active.
- Showing (JSON or verbose) a measurement name that does not exist.
- A time range where the start is not strictly before the end.
- A time range whose source data is unavailable - nothing in OpenClaw's audit ledger falls
  inside the window (wrong range, a typo, or the window is older than the ledger's 30-day /
  100,000-row retention - see [Data sources](#data-sources)).

## The report

`/probe <name>` prints the report exactly as stored (see [`ProbeReport`](src/types.ts) for
the TypeScript shape). `/probe verbose <name>` prints the same data as prose with an
explanation attached to every section.

```jsonc
{
  "probe": {
    "name": "baseline",
    "mode": "start-stop",       // "start-stop" (bracketed by /probe start../stop) or "range"
    "generated_at": "2026-08-01T12:03:41.221Z"
  },
  "window": {
    "ts_start": "2026-08-01T12:00:00.000Z",
    "ts_end": "2026-08-01T12:03:41.210Z",
    "wall_clock_sec": 221.21        // real time between ts_start and ts_end
  },
  "sessions": {
    "session_ids": ["agent:main:main"],   // every session with an audit event in the window
    "agents_used": { "main": 3 }          // completed agent runs per agentId (shows sub-agent participation)
  },
  "time": {
    "agent_active_sec": 41.7,   // sum of (run finished - run started) over completed runs
    "llm_latency_sec": 33.2,    // agent_active_sec - tool_exec_sec, floored at 0 (model wait time, approximated)
    "tool_exec_sec": 8.5        // sum of (tool call finished - started)
  },
  "iterations": {
    "agent_runs": 3,            // completed top-level agent turns (main + any sub-agent runs)
    "llm_calls": 7,             // individual model completions, including mid-run tool-calling steps
    "tool_calling_rounds": 4,   // of those, how many produced at least one tool call
    "tool_calls_total": 6       // individual tool invocations
  },
  "models_used": { "anthropic/claude-x": 7 },   // LLM calls per "provider/model"
  "tokens": {
    "input": 18422,
    "output": 1310,
    "cacheRead": 15900,
    "cacheWrite": 2100,
    "reasoningTokens": 0,
    "total": 19732
  },
  "context": {
    "system_prompt_chars_samples": [48211, 48380, 48211],  // one sample per completed run
    "system_prompt_chars_avg": 48267
  },
  "tools_used": { "k8s_get_pods": 2, "postgres_query": 1, "read": 3 },
  "plugins_used": ["core", "k8s-ops", "postgres-ops"],     // owning plugin per tool above ("core" = built-in)
  "skills_used": { "aiops-incident": { "name": "aiops-incident", "uses": 1 } },  // or null - see below
  "errors": {
    "tool_call_errors": {
      "count": 1,
      "by_tool": { "postgres_query": 1 },
      "by_status": { "failed": 1 },
      "by_code": { "connection_refused": 1 }
    },
    "agent_run_errors": { "count": 0, "by_status": {}, "by_code": {} }
  },
  "llm_api_log": {
    "entries_captured": 7,
    "file": "/root/.openclaw/state/plugins/probe/results/baseline.rawrequests.jsonl"
  },
  "warnings": []
}
```

### Field reference

**`probe`** - identity of the measurement.
- `name` - as given to `/probe start <name>`, or `"<start> .. <end>"` for a range probe.
- `mode` - `start-stop` or `range`.
- `generated_at` - when the report was computed (can be well after `window.ts_end` for a
  range probe run long after the fact).

**`window`** - the time boundaries of the measurement, exactly as requested (start/stop
timestamps or the explicit range you gave). Not derived from any log.

**`sessions`**
- `session_ids` - every OpenClaw session with at least one audit event in the window. A
  probe can span more than one session (e.g. a webhook-triggered run in a different
  session).
- `agents_used` - completed agent runs per `agentId`, so you can see whether sub-agents
  (diagnostic workers, etc.) participated, not just the main agent.

**`time`** - all three numbers come from pairing `agent.run.started`/`finished` and
`tool.action.started`/`finished` events in the audit ledger:
- `agent_active_sec` - time the agent was actually working (excludes idle time between
  runs, unlike `window.wall_clock_sec`).
- `tool_exec_sec` - time spent inside tool calls (kubectl/psql/exec/etc).
- `llm_latency_sec` - `agent_active_sec - tool_exec_sec`, floored at 0. An **approximation**
  of model wait time - the audit ledger does not record LLM call boundaries directly, only
  run and tool boundaries.

**`iterations`**
- `agent_runs` - completed top-level agent turns (audit ledger).
- `llm_calls` - individual model completions across all runs, including mid-run
  tool-calling steps (from each run's trajectory file).
- `tool_calling_rounds` - of those LLM calls, how many produced at least one tool call.
- `tool_calls_total` - individual tool invocations (audit ledger; a "round" can contain
  several parallel tool calls).

**`models_used`** - LLM call count per `"provider/model"`, read per assistant message (not
the run's default model), so a mid-run fallback to a different model is captured correctly.

**`tokens`** - summed `usage` from every LLM call in the window, as reported by the
provider. This is the primary number for cost experiments: compare `total`/`input`/
`cacheRead` across two probes.

**`context`** - `system_prompt_chars_samples` is one compiled-system-prompt-size sample
(characters) per completed run that has one; `system_prompt_chars_avg` is their average. A
proxy for context bloat.

**`tools_used`** / **`plugins_used`** - tool call counts by name, and the owning plugin id
for each (`"core"` for built-in tools not from an installed plugin).

**`skills_used`** - use counts per skill in the window, or **`null`** if the bundled
`skill-usage` plugin's event log was not found on this host (that plugin not
installed/enabled) - distinct from `{}`, which means the plugin is present but nothing was
invoked.

**`errors`** - tool calls and agent runs that did not finish with status `succeeded`,
broken down by tool/status/error code.

**`llm_api_log`** - `entries_captured` and the path to a `.rawrequests.jsonl` file with the
full request/response for every LLM call in the window (one JSON object per line: provider,
model, full system prompt/prompt/history, response text, usage, duration). `null`/`0` when
raw capture is disabled or not authorized (see [Requirements](#requirements)),
or simply had nothing to capture. This is purely archival for close inspection of prompts -
none of the numeric metrics above depend on it.

**`warnings`** - non-fatal notes, e.g. a run's trajectory file was rotated/deleted before
the report could read it, or `skills_used` came back `null`.

## Data sources

| Data | Source |
| --- | --- |
| Time, agent/tool run pairing, errors, tool names, session/agent ids | `openclaw audit --json --after <ms> --before <ms>` (paginated). Metadata-only, 30-day / 100,000-row retention - see [Audit records](https://docs.openclaw.ai/cli/audit). |
| Tokens, LLM call count, tool-calling rounds, models used, context size | Each involved run's trajectory file: `<base>/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl` (`model.completed` and `context.compiled` events). |
| Skill usage | The bundled `skill-usage` plugin's own event log: `<base>/state/plugins/skill-usage/events/skill-usage-events.jsonl`, filtered by timestamp. Best-effort - `null` if that plugin isn't present. |
| Tool -> plugin ownership | `openclaw plugins list --json`, each plugin's manifest-declared `contracts.tools` (no plugin runtimes are loaded to compute this, so it stays fast regardless of how many plugins are installed). |
| Raw LLM request/response archive | This plugin's own `llm_input`/`llm_output` hook handlers, written to `<base>/logs/probe/llm-api/<date>.jsonl` - independent of the `llm-api-logger` plugin. |

`<base>` is the OpenClaw base directory (normally `~/.openclaw`, or wherever
`--profile`/`--dev`/`OPENCLAW_STATE_DIR` point it).

Probe shells out to the `openclaw` CLI for the audit ledger and plugin registry (the only
stable, documented surfaces available to an external plugin for that data) - each `/probe`
command that builds a new report typically takes a few seconds because of this, which is
expected for a report you request explicitly, not something running on a hot path.

### Why the audit ledger's retention matters

`/probe <start> <end>` for a window with no matching data is rejected with a clear error
(see [Error messages](#error-messages)) rather than silently returning a report full of
zeros. The most common cause is asking for a range older than the audit ledger's 30-day
retention, or a Gateway restart/`audit.enabled: false` period during the window - always
double-check the requested range first.

## Configuration

All fields are optional; defaults shown.

```json5
{
  "plugins": {
    "entries": {
      "probe": {
        "config": {
          "openclawBin": "openclaw",   // binary/path used to shell out for audit + plugin data
          "cliTimeoutMs": 30000,       // timeout per `openclaw audit`/`openclaw plugins list` call
          "llmLog": {
            "enabled": true,           // capture raw LLM request/response (needs allowConversationAccess, see above)
            "maxFileSizeMb": 20,       // rotate the day's raw log file past this size
            "maxFiles": 14,            // rotated files to keep before deleting the oldest
            "redactSecrets": true      // redact secret-shaped strings/keys before writing to disk
          }
        }
      }
    }
  }
}
```

## Development

```bash
npm install
npm run build
npm test
npm run plugin:install   # build + `openclaw plugins install . --force`
```

Source layout: `src/cli.ts` (subprocess calls to `openclaw`), `src/trajectory.ts` /
`src/skillUsage.ts` (filesystem readers), `src/llmCapture.ts` (hook-based raw log capture),
`src/report.ts` (aggregation), `src/commands.ts` (`/probe` argument parsing and dispatch),
`src/format.ts` (verbose report rendering), `src/index.ts` (plugin registration).

## License

MIT - see [LICENSE](LICENSE).
