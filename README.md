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

### Enable raw LLM request/response capture (optional)

Probe's core metrics (time, tokens, tool/skill usage, errors) work out of the box. The
**optional** raw request/response archive (full system prompt/prompt/response text for
every LLM call in a probe's window) uses the `llm_input`/`llm_output` hooks, which OpenClaw
gates behind an explicit opt-in for any plugin that isn't bundled with OpenClaw itself:

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

Without this, `/probe` still works fully - `llm_api_log.entries_captured` will just be `0`
and `llm_api_log.file` will be `null` in every report, with a note in `warnings`.

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
raw capture is disabled or not authorized (see [Enable raw capture](#enable-raw-llm-requestresponse-capture-optional)),
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
