# Template Schema (`daemon/v1`)

This document defines the current `subd` agent template format, including heartbeat checks, hooks, and EJS helper functions.

## Minimal template

```yaml
apiVersion: daemon/v1
kind: Agent
metadata:
  description: General purpose helper
  model: xai:grok-4-fast-reasoning
spec:
  system_prompt: |
    You are a helpful assistant.
```

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---:|---|
| `apiVersion` | string | yes | Must be `daemon/v1`. |
| `kind` | string | yes | Must be `Agent`. |
| `metadata` | object | yes | Runtime + behavior config. |
| `spec` | object | yes | Prompt and execution-facing data. |

## `metadata` fields

| Field | Type | Required | Notes |
|---|---|---:|---|
| `description` | string | no | Human-friendly description. |
| `model` | string | no | Provider-prefixed model string, e.g. `xai:grok-4-fast-reasoning`. |
| `tools` | array | no | Tool allowlist for the session. |
| `labels` | array | no | Optional tags. |
| `hooks` | array/object | no | Template-local hooks merged with repo/user hooks. |
| `heartbeat` | object | no | Heartbeat scheduler/check config used by `subd cron`. |

## `spec` fields

| Field | Type | Required | Notes |
|---|---|---:|---|
| `system_prompt` | string | no | EJS-rendered prompt text. |

---

## Heartbeat schema

Heartbeat is template-local under `metadata.heartbeat` and consumed by:
- `subd cron once`
- `subd cron watch`

### Heartbeat object

| Field | Type | Required | Notes |
|---|---|---:|---|
| `interval_seconds` | number | no | Default interval for checks missing `every`. |
| `system_prompt` | string | no | Optional per-template fragment aggregated into global heartbeat prompt. |
| `checks` | array | no | List of heartbeat checks. |
| `on_attention` | object | no | Optional behavior when a check returns attention. |

### Check schema (`metadata.heartbeat.checks[]`)

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | string | yes | Unique check key within template. |
| `enabled` | boolean | yes | Per-check enablement. |
| `type` | string | yes | One of: `agent`, `shell`. |
| `every` | string | no | Cadence (`30m`, `2h`, `1d`, etc.). |
| `active_hours` | string | no | Time gate (`HH:MM-HH:MM`). |
| `timeout_seconds` | number | no | Per-check timeout override. |
| `template` | string | agent only | Template to run for agent check. |
| `prompt` | string | agent only | Initial user prompt for agent check. |
| `command` | string | shell only | Command executed by shell check. |

### Check pass contract (shared for `agent` and `shell`)

- Check output must be structured JSON.
- JSON must include key `ok`.
- Pass requires `ok` to be truthy.
- Suggested shape:

```json
{"ok": true, "summary": "HEARTBEAT_OK"}
```

### Heartbeat examples

```yaml
apiVersion: daemon/v1
kind: Agent
metadata:
  description: Workspace monitor
  model: xai:grok-4-fast-reasoning
  heartbeat:
    interval_seconds: 300
    system_prompt: |
      ### AGENT HEARTBEAT PROMPT: workspace-monitor
      Focus on actionable, low-noise attention signals.
    checks:
      - id: git-health
        enabled: true
        type: shell
        command: bun -e 'console.log(JSON.stringify({ok:true,summary:"git clean"}))'
        every: 30m
      - id: inbox-triage
        enabled: true
        type: agent
        template: mini-solo
        prompt: |
          Check inbox-like sources and respond in JSON only:
          {"ok": true|false, "summary": "..."}
        every: 30m
        active_hours: "09:00-21:00"
    on_attention:
      mode: hook_only
spec:
  system_prompt: |
    You are a monitor.
```

---

## Hooks

Hook behavior, schema, events, execution, and examples are documented in:

- [docs/HOOKS.md](docs/HOOKS.md)

---

## EJS in prompts

`spec.system_prompt` is rendered using EJS.

### Available EJS functions/objects

| Name | Params | Returns | Description |
|---|---|---|---|
| `readStdin` | none | `Promise<string>` | Reads stdin content when `-i` is provided. |
| `shell` | `command: string, options?: object` | `string\|Buffer` | Executes a command via `execSync` and returns output (trimmed by default). |
| `includePrompt` | `includePath: string` | `string` | Includes file contents using workspace-relative path with safety checks. |
| `process` | n/a | object | Node/Bun process object (cwd, env, platform, etc.). |
| `os` | n/a | object | Node `os` module helpers (`release()`, etc.). |

### `includePrompt` path/safety rules

- Paths must be workspace-relative.
- Absolute paths are rejected.
- Path traversal outside workspace is rejected.
- Missing files fail fast.
- Circular includes fail fast.
- Include depth is bounded.

### EJS examples

```yaml
spec:
  system_prompt: |
    Today: <%= new Date().toISOString() %>
    CWD: <%= process.cwd() %>

    Shared rules:
    <%- includePrompt('agent/snippets/shared/rules.md') %>

    Tool help:
    <%= shell('skills memo') %>

    Conversation history:
    <%= await readStdin() %>
```

---

## Global heartbeat prompt composition

`subd cron` builds the effective heartbeat system prompt by:

1. Loading the global prompt template from config (`heartbeat.system_prompt_file`).
2. Rendering EJS (including `includePrompt`).
3. Injecting aggregated template heartbeat fragments via EJS variable:

```ejs
<%= heartbeat_agent_prompts %>
```

Default config points to:
- `agent/snippets/heartbeat/global.ejs`
