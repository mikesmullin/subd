# MSGQ

This document explains the `msgq` plugin: a filesystem-backed message bus for tasks, handoffs, and agent-to-agent coordination.

## Design Goal

Use one minimal bus model instead of many specialized plugins.

Benefits:

- Small tool surface area
- Easy shell-level inspection/debugging
- Atomic claim semantics using file moves

## Directory Layout

All paths are relative to current working directory:

```text
agent/msgq/
  pending/
  assigned/
  archive/
  teams/
```

## Atomic Claim Rule

Claim lock acquisition is implemented as:

```bash
mv agent/msgq/pending/<id>.md agent/msgq/assigned/<id>.md
```

- Exit code `0` means claim succeeded.
- Non-zero means item missing or already claimed.

## Message Format

Each item is a Markdown file with YAML frontmatter.

Core fields include:

- Required: `id`
- Common optional: `type`, `sender`, `recipient`, `priority`, `status`, `assignee`, `payload`, `history`

Defaults (when omitted):

- `type`: `note`
- `recipient`: `broadcast`
- `priority`: `normal`
- `blockedBy`: `[]`
- `payload`: `{}`
- `history`: `[]`

## Tool API

- `msgq__append`: create pending message
- `msgq__claim`: claim by id or next eligible
- `msgq__list`: list with state/field filters
- `msgq__await`: wait for queue changes or until `min_count` is reached (blocks indefinitely by default)
- `msgq__update`: mutate assigned item + append history
- `msgq__archive`: move to archive with resolution
- `msgq__bcast`: fan out one payload to many recipients

`msgq__await` is useful for lead orchestration loops because it removes the need to poll filesystem paths directly.

Behavior:

- If `timeout_ms` is omitted or `0`, it waits indefinitely.
- If `min_count` is provided, it returns when the filtered set size reaches/exceeds that count.
- If `min_count` is omitted and matches already exist, it returns immediately (`reason: items_available`).
- If `min_count` is omitted and no matches exist yet, it returns when the filtered queue view changes.

Common patterns:

- Wait until all tasks are done: `msgq__await(state=archive, type=task, min_count=3)`
- Wait for first lead note: `msgq__await(state=pending, recipient=agent:lead, type=note, min_count=1, timeout_ms=30000)`
- Wait for any change to a filtered view: call without `min_count`

## Claim Ordering (No ID)

When `msgq__claim` is called without id:

1. Filter to eligible (unclaimed, unblocked)
2. Sort by `priority` descending
3. Break ties by `created_at` ascending

## Safety Rules

- Path confinement: all operations stay under current workspace root.
- Ownership checks: only assignee can update/archive assigned items.
- Idempotent archive intent: repeated archive calls should be safe to reason about.
- Parse-failure strategy: malformed entries should be quarantined (`archive/invalid`) in stricter flows.

## Hooks + MSGQ

`msgq` operations can emit and/or consume message lifecycle hooks.

Typical mapping:

- append path: `message_sending` (guard) -> write -> `message_sent`
- claim path: `message_claimed` (guard)
- update path: `message_updated` (guard)
- archive path: `message_archived` + optionally `task_completed` for completed tasks

This allows policy and automation without coupling business logic directly into tool code.

## Sandbox / Host-Write Model

In `-a` mode, writes should route to host process over bridge to keep canonical queue state outside container.

This avoids split-brain state between host and container filesystems.

## Minimal Workflow Example

1. `msgq__append` creates task
2. worker calls `msgq__claim`
3. worker sends progress via `msgq__update`
4. worker finalizes with `msgq__archive`
