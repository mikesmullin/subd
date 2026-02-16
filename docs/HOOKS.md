# HOOKS

This document explains how hook automation works in `subd`.

## What Hooks Are

Hooks are event-driven actions that run at specific points in an agent lifecycle.

- Use hooks to enforce policy (block unsafe actions).
- Use hooks to automate side-effects (logging, notifications, memory recall/save).
- Use hooks as optional automation; core tools still work without them.

## Where Hooks Are Loaded From

Hook definitions are merged using this precedence (highest first):

1. Template-local hooks (`metadata.hooks` in the selected template)
2. User-global hooks (`~/.config/daemon/agent/hooks/*.yaml`)
3. Repo-global hooks (`agent/hooks/*.yaml`)

Conflict rule:

- Same hook identity (`on` + `name`) is overridden by the higher-precedence source.

## Hook Definition Format

Minimal hook shape:

```yaml
name: my-hook-name
on: user_prompt_submit
enabled: true
when:
  channel: cli
do:
  type: command
  command: "./scripts/my-hook.sh"
  timeout: 30
```

Supported action types:

- `command`: Runs shell command and passes hook payload JSON on stdin.
- `agent`: Launches a nested `subd` run; requires `template` and `prompt`.

Example `agent` action:

```yaml
do:
  type: agent
  template: mini-solo
  prompt: "Analyze this event and decide a follow-up action."
  timeout: 90
```

## Hook Events (Current Set)

- `session_start`
- `session_end`
- `user_prompt_submit`
- `before_agent_start`
- `assistant_response_emit`
- `pre_tool_call`
- `permission_request`
- `post_tool_call`
- `post_tool_failure`
- `before_compaction`
- `after_compaction`
- `agent_terminated_stop`
- `teammate_idle`
- `subagent_start`
- `subagent_stop`
- `message_received`
- `message_sending`
- `message_sent`
- `message_claimed`
- `message_updated`
- `message_archived`
- `task_completed`

## Blocking vs Non-Blocking Behavior

A falsy hook result means:

- `command`: non-zero exit code
- `agent`: non-success nested execution

Selected blocking behaviors:

- `user_prompt_submit`: blocks prompt from entering context; turn is skipped.
- `before_agent_start`: blocks current model turn.
- `assistant_response_emit`: blocks assistant message write; rejection prompt is injected as user message.
- `pre_tool_call`: blocks tool invocation.
- `permission_request`: blocks/denies auto-approval path.
- `agent_terminated_stop`: blocks termination and continues loop.

Selected non-blocking/log-only behaviors:

- `post_tool_call`, `post_tool_failure`, `message_sent`, `session_end` generally preserve the original result and skip only hook side-effects.

## Hook Input Payload

All hooks receive base JSON payload on stdin:

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

Event-specific fields are added depending on hook type, for example:

- `user_prompt_submit`: `user_message`, `channel`
- `assistant_response_emit`: `assistant_message`, `assistant_message_id`, `response_channel`
- `pre_tool_call`: `tool_name`, `tool_input`, `raw_tool_call`
- `post_tool_failure`: `error_message`, `exit_code`
- `task_completed`: `task_id`, `result_summary`, `files_changed`

## Practical Patterns

1. Pre-prompt memory recall:

- Attach a `user_prompt_submit` command hook.
- Read payload from stdin.
- Retrieve relevant memory and persist audit/log artifacts.

2. Post-response memory save:

- Attach an `assistant_response_emit` command hook.
- Extract facts from `assistant_message`.
- Write or update your memory store.

## Notes

- Compaction events are defined but may not fire until compaction flow is implemented.
- Keep blocking hooks fast and deterministic to avoid stalling turns.
- Prefer short timeouts and explicit failure messages for easier debugging.
