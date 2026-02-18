# HOOKS

This document describes hook automation in `subd`.

## What Hooks Are

Hooks are event-driven automations that run at specific lifecycle points.

- Use hooks for policy checks and guardrails.
- Use hooks for side effects (logging, notifications, memory workflows).
- Keep blocking hooks fast and deterministic.

## Load Order and Override Rule

Hook definitions are merged with this precedence (highest first):

1. Template hooks (`metadata.hooks`)
2. User hooks (`~/.config/daemon/agent/hooks/*.yaml`)
3. Repo hooks (`agent/hooks/*.yaml`)

If two hooks share the same identity (`on` + `name`), higher precedence overrides lower precedence.

## Hook Shape (Jobs First)

```yaml
hooks:
  - name: mem-save-on-user-prompt
    on: user_prompt_submit
    when:
      channel: cli
    jobs:
      memorize-user-facts:
        steps:
          - id: proposed
            type: llm
            template: memory-user-extract
            stdin: |
              User: ${{ user_message }}
            prompt: go

          - id: existing
            type: shell
            command: bun plugins/memory/scripts/retrieve-existing-memories.mjs
            stdin: ${{ steps.proposed.output }}

          - id: diff
            type: llm
            template: memory-maintain
            prompt: go
            data:
              proposed_memories: ${{ parseJSON(steps.proposed.output).facts }}
              existing_memories: ${{ parseJSON(steps.existing.output) }}

          - id: apply
            type: shell
            command: bun plugins/memory/scripts/apply-memory-events.mjs
            stdin: ${{ steps.diff.output }}
```

## Execution Model

### Jobs

- `jobs.<job>.needs` defines DAG dependencies.
- Jobs without `needs` can start immediately.
- Jobs with satisfied `needs` can run in parallel.
- Steps inside each job run serially.

### Steps

- `id` is optional, but required for stable references.
- Downstream references use `steps.<id>.output`.
- Step output is always a single string from stdout.

## Expressions

### Syntax

Use `${{ ... }}` in hook fields.

### Available Roots

- Event payload keys directly, e.g. `${{ user_message }}`
- Step output by id, e.g. `${{ steps.proposed.output }}`

### Functions

- `parseJSON(string)`: parse string output into object/array

`parseJSON(...)` is strict: invalid JSON fails the step.

## Type Rules

- `command`, `prompt`, `stdin`, and all `env` values must resolve to strings.
- `data` values may resolve to any JSON-compatible type.

## Supported Step Types

- `shell` (shell command)
- `llm` (nested `subd` template run)

## `when` Conditions

`when` filters hooks by payload values.

Matchers:
- Exact match: `when: { channel: cli }`
- Any-of: `when: { response_channel: [cli, api] }`
- Wildcard `*`: `when: { tool_name: "shell__*" }`

All `when` keys must match.

## Hook Events

Current events include:

- `heartbeat_tick`
- `heartbeat_check_selected`
- `heartbeat_result`
- `heartbeat_attention`
- `session_start`
- `session_end`
- `user_prompt_submit`
- `before_agent_start`
- `assistant_response_emit`
- `pre_tool_call`
- `permission_request`
- `post_tool_call`
- `post_tool_failure`
- `agent_terminated_stop`
- `message_sending`
- `message_sent`
- `message_claimed`
- `message_updated`
- `message_archived`
- `msgq_appended`
- `msgq_claimed`
- `msgq_updated`
- `msgq_archived`
- `task_completed`

## Blocking Behavior

Hook failures can block selected events (for example `user_prompt_submit`, `before_agent_start`, `assistant_response_emit`, `pre_tool_call`, `permission_request`).

Post-event hooks are generally non-blocking and preserve the original event outcome.

## Hook Payload

All hooks receive a base JSON payload on stdin:

```json
{
  "hook": "event_name",
  "session_id": "sess_abc123",
  "timestamp": "2026-02-15T17:45:00Z",
  "agent_id": "main",
  "workspace": "/path/to/project",
  "reason": "optional prior context"
}
```

Event-specific fields are included as relevant (for example `user_message`, `assistant_message`, `tool_name`, `tool_input`, `error_message`).
