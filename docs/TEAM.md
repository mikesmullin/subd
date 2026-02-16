# TEAM

How team-of-agents orchestration is performed.

## Example Goal

Run a lead + three workers workflow where:

- Lead creates project tasks in msgq
- Workers pull and complete tasks independently
- Lead waits on msgq completion gate
- Lead destroys the team after completion

Coordination is done through msgq, which uses MSGQ (with fs await, instead of polling).

## Templates

Below are snapshot copies of the known-good templates used in the successful team run.

### Template: `gp-lead-pull.yaml`

```yaml
---
apiVersion: daemon/v1
kind: Agent
metadata:
  description: Pull-based lead orchestrator for guinea pig website
  model: xai:grok-4-fast-reasoning
  max_turns: 16
  tools:
    - fs__directory__create
    - fs__file__create
    - fs__file__view
    - fs__file__edit
    - msgq__append
    - msgq__list
    - msgq__await
    - team__create
    - team__destroy
spec:
  system_prompt: |
    You are lead orchestrator agent:lead.
    Build a pull-based workflow using msgq and team-managed child agents.

    Required workflow:
    1) Create tmp/guinea-site and tmp/guinea-site/coordination.
      2) Do not create any custom mailbox files; lead notifications must use msgq with recipient agent:lead.
    3) Create exactly 3 task messages in msgq with recipients:
       - agent:frontend
       - agent:backend
       - agent:sdet
     4) Create a worker team using team__create with exactly three workers:
       - gp-worker-frontend-pull
       - gp-worker-backend-pull
       - gp-worker-sdet-pull
       team__create must launch them asynchronously and persist team state under agent/msgq/teams.
       For workers[].template use these exact values only:
       - gp-worker-frontend-pull
       - gp-worker-backend-pull
       - gp-worker-sdet-pull
       Never use generic fallback templates (e.g., "agent").
      Set workers[].sandbox=false unless explicitly instructed otherwise.
      If explicitly instructed to run workers in sandbox, set workers[].sandbox=true and pass a shared `sandbox_volumes` list to team__create so all workers use the same bind mounts.
       Provide prompt + output log path for each worker under tmp/guinea-site/coordination/*.log.
     5) Wait using msgq only (never fs__file__await):
       - Use msgq__await(state=archive, type=task, min_count=3) as the completion gate (no timeout by default).
       - Use msgq__list(state=pending, recipient=agent:lead, type=note) to read completion notes.
       - Optionally call msgq__await(state=pending, recipient=agent:lead, type=note, min_count=1) for note activity.
       Continue until exactly 3 project tasks are archived.
     6) Call team__destroy(team_id=<created team>) to gracefully stop idle workers after completion.
     7) Return final summary including archived task ids.

    Constraints:
    - Pull model only: workers must claim their own tasks.
    - Do not manually claim/archive worker tasks as lead.
    - Keep website scope <= 10 pages.
```

### Template: `gp-worker-frontend-pull.yaml`

```yaml
---
apiVersion: daemon/v1
kind: Agent
metadata:
  description: Pull-based frontend worker for guinea pig website
  model: xai:grok-4-fast-reasoning
  max_turns: 20
  hooks:
    - name: notify-lead-on-task-complete
      on: task_completed
      do:
        type: command
        command: "./tmp/hooks/task_completed_mailbox.sh"
        timeout: 10
  tools:
    - fs__directory__list
    - fs__file__view
    - fs__file__create
    - fs__file__edit
    - fs__patch__apply
    - fs__directory__create
    - fs__grep
    - msgq__claim
    - msgq__await
    - msgq__list
    - msgq__update
    - msgq__archive
spec:
  system_prompt: |
    You are frontend worker agent:frontend.
    Pull your own task from msgq using recipient filter.
    Required execution order:
     1) Recovery check first: msgq__list(state=assigned, assignee=agent:frontend, type=task, limit=1).
       If an assigned task exists, resume it immediately (do not wait/claim again).
     2) If no assigned task exists, wait for available task using msgq__await(state=pending, recipient=agent:frontend, type=task)
       then claim one task for recipient agent:frontend.
    2) build/update website files under tmp/guinea-site
    3) update task progress
    4) archive task with resolution completed
    Always use assignee=agent:frontend in msgq__claim/msgq__update/msgq__archive.
    Never skip claim/archive steps.
```

### Template: `gp-worker-backend-pull.yaml`

```yaml
---
apiVersion: daemon/v1
kind: Agent
metadata:
  description: Pull-based backend worker for guinea pig website
  model: xai:grok-4-fast-reasoning
  max_turns: 20
  hooks:
    - name: notify-lead-on-task-complete
      on: task_completed
      do:
        type: command
        command: "./tmp/hooks/task_completed_mailbox.sh"
        timeout: 10
  tools:
    - fs__directory__list
    - fs__file__view
    - fs__file__create
    - fs__file__edit
    - fs__patch__apply
    - fs__directory__create
    - fs__grep
    - msgq__claim
    - msgq__await
    - msgq__list
    - msgq__update
    - msgq__archive
spec:
  system_prompt: |
    You are backend worker agent:backend.
    Pull your own task from msgq using recipient filter.
    Required execution order:
     1) Recovery check first: msgq__list(state=assigned, assignee=agent:backend, type=task, limit=1).
       If an assigned task exists, resume it immediately (do not wait/claim again).
     2) If no assigned task exists, wait for available task using msgq__await(state=pending, recipient=agent:backend, type=task)
       then claim one task for recipient agent:backend.
    2) produce/update data/docs under tmp/guinea-site
    3) update task progress
    4) archive task with resolution completed
    Always use assignee=agent:backend in msgq__claim/msgq__update/msgq__archive.
    Never skip claim/archive steps.
```

### Template: `gp-worker-sdet-pull.yaml`

```yaml
---
apiVersion: daemon/v1
kind: Agent
metadata:
  description: Pull-based SDET worker for guinea pig website
  model: xai:grok-4-fast-reasoning
  max_turns: 20
  hooks:
    - name: notify-lead-on-task-complete
      on: task_completed
      do:
        type: command
        command: "./tmp/hooks/task_completed_mailbox.sh"
        timeout: 10
  tools:
    - fs__directory__list
    - fs__file__view
    - fs__file__create
    - fs__file__edit
    - fs__patch__apply
    - fs__directory__create
    - fs__grep
    - msgq__claim
    - msgq__await
    - msgq__list
    - msgq__update
    - msgq__archive
spec:
  system_prompt: |
    You are SDET worker agent:sdet.
    Pull your own task from msgq using recipient filter.
    Required execution order:
     1) Recovery check first: msgq__list(state=assigned, assignee=agent:sdet, type=task, limit=1).
       If an assigned task exists, resume it immediately (do not wait/claim again).
     2) If no assigned task exists, wait for available task using msgq__await(state=pending, recipient=agent:sdet, type=task)
       then claim one task for recipient agent:sdet.
    2) produce/update QA assets under tmp/guinea-site
    3) update task progress
    4) archive task with resolution completed
    Always use assignee=agent:sdet in msgq__claim/msgq__update/msgq__archive.
    Never skip claim/archive steps.
```

## Tools Used by Lead

- `msgq__append`
- `msgq__await`
- `msgq__list`
- `team__create`
- `team__destroy`

## Team Lifecycle

`team__create` launches workers asynchronously and writes team metadata to:

- `agent/msgq/teams/<team_id>.yml`

Team member records include generated canonical `session_id` values and pids. `team__destroy` sends graceful stop signals and records stop outcomes.

## Canonical Session ID Policy

Session files are now expected to use one canonical format:

- `<timestampMs>-<pid>-<hex4>.yml`

Examples:

- `1771208672042-143059-84e7.yml`

Non-canonical session IDs are rejected for `--session-id`.
Team launches always generate canonical session IDs internally to avoid collisions and naming variance.

## End-to-End Run Command

```bash
rm -rf tmp/guinea-site
bun cli.mjs clean
bun cli.mjs -t gp-lead-pull -v -o tmp/e2e/lead-pull-e2e.log \
  "Execute the pull-based guinea pig website workflow now using team lifecycle: create team, let workers pull via msgq await, wait for 3 archived tasks, consume lead notes, destroy team, and return archived ids."
```

## End-to-End (All Sandboxed + Shared Mount)

```bash
rm -rf tmp/guinea-site
mkdir -p tmp/guinea-site tmp/guinea-site/coordination
bun cli.mjs clean
bun cli.mjs -s \
  --volume "$PWD/tmp/guinea-site:/workspace/subd/tmp/guinea-site" \
  -t gp-lead-pull -v -o tmp/guinea-site/coordination/lead-pull-e2e-sandbox.log \
  "Execute the pull-based guinea pig website workflow now with all agents sandboxed. Use team__create with workers[].sandbox=true and set team__create sandbox_volumes to ['/workspace/subd/tmp/guinea-site:/workspace/subd/tmp/guinea-site']. Keep all project outputs in tmp/guinea-site, wait for 3 archived tasks, consume lead notes, destroy team, and return archived ids."
```

## Outcome Verification Commands

### 1) Tasks archived

```bash
echo "pending=$(find agent/msgq/pending -maxdepth 1 -type f -name '*.md' | wc -l) assigned=$(find agent/msgq/assigned -maxdepth 1 -type f -name '*.md' | wc -l) archive=$(find agent/msgq/archive -maxdepth 1 -type f -name '*.md' | wc -l)"
ls -1 agent/msgq/archive
```

Expected:

- `pending=0`
- `assigned=0`
- `archive=3`
- files: three archived task markdown files (id prefix may vary, e.g. `task-*` or `guinea-task-*`)

### 2) Lead notes present

```bash
ls -1 agent/msgq/pending | grep -E 'lead_note|note' || true
```

Expected:

- note files may exist if workers append lead notes in your prompt run; absence does not invalidate archive completion

### 3) Lead session completed

```bash
latest=$(ls -t agent/sessions/*.yml | head -n1)
echo "$latest"
tail -n 200 "$latest"
```

Expected:

- lead session includes `team__create` -> `msgq__await(min_count=3)` -> `team__destroy`
- final assistant summary includes archived task IDs

### 4) Worker processes cleaned up

```bash
ps -ef | grep -E 'gp-worker-frontend-pull|gp-worker-backend-pull|gp-worker-sdet-pull' | grep -v grep || true
```

Expected:

- no lingering worker processes

## Troubleshooting

If an agent hits turn limit, a troubleshooting note is appended to its session YAML:

- `unable to continue; max turns policy exceeded (limit=N)`

This note is intentionally persisted as a `user` message for post-run diagnosis.
