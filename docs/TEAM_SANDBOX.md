# TEAM_SANDBOX

How to run and verify the pull-based team e2e with all agents sandboxed.

## Goal

Run lead + three workers in sandbox containers, with one shared writable project directory (`tmp/guinea-site`) and host-centralized msgq state.

## Build / Refresh Image

```bash
podman build -t subd:latest .
```

## Full Sandboxed E2E Command

```bash
podman unshare rm -rf tmp/guinea-site 2>/dev/null || true
rm -rf tmp/guinea-site
mkdir -p tmp/guinea-site/coordination tmp/e2e
bun cli.mjs clean
bun cli.mjs -s \
  -V "$PWD/tmp/guinea-site:/workspace/subd/tmp/guinea-site" \
  -t gp-lead-pull -v \
  "Execute the pull-based guinea pig website workflow now with all agents sandboxed. Use team__create with exactly three workers where workers[].sandbox=true and set team__create sandbox_volumes to ['/workspace/subd/tmp/guinea-site:/workspace/subd/tmp/guinea-site']. Use only msgq__append/msgq__await/msgq__list/team__create/team__destroy for orchestration (do not write agent/msgq files via fs tools). Workers must never use fs tools for agent/msgq paths; use msgq tools only. Wait for exactly 3 archived task messages, consume lead notes, then call team__destroy with force_after_ms=3000 and return archived ids." \
  > tmp/e2e/lead-pull-e2e-sandbox.stdout.log 2>&1
```

## Verification

### 1) Task queue state

```bash
echo "pending=$(find agent/msgq/pending -maxdepth 1 -type f -name '*.md' | wc -l) assigned=$(find agent/msgq/assigned -maxdepth 1 -type f -name '*.md' | wc -l) archive=$(find agent/msgq/archive -maxdepth 1 -type f -name '*.md' | wc -l)"
ls -1 agent/msgq/archive
```

Expected:

- `pending=0`
- `assigned=0`
- `archive=3`

### 2) Lead session flow

```bash
latest=$(ls -t agent/sessions/*.yml | head -n1)
echo "$latest"
grep -n "name: msgq__append\|name: msgq__await\|name: msgq__list\|name: team__create\|name: team__destroy\|finish_reason: stop\|Archived Task IDs" "$latest"
```

Expected:

- Includes `team__create` -> `msgq__await(min_count=3)` -> `team__destroy`
- Includes archived task IDs summary
- Ends with `finish_reason: stop`

### 3) No lingering workers/containers

```bash
ps -ef | grep -E 'gp-worker-frontend-pull|gp-worker-backend-pull|gp-worker-sdet-pull' | grep -v grep || true
podman ps --format '{{.Names}}' | grep '^subd-sandbox-' || true
```

Expected:

- No lingering worker processes
- No running `subd-sandbox-*` containers

### 4) Shared directory output visible on host

```bash
find tmp/guinea-site -maxdepth 3 -type f | head -n 50
```

Expected:

- Frontend/backend/test output files exist under `tmp/guinea-site`

## Troubleshooting

1. **`rm -rf tmp/guinea-site` permission denied**
   - Happens after user-namespace-mapped container writes.
   - Use:

```bash
podman unshare rm -rf tmp/guinea-site
```

2. **Archive appears as `0` despite successful run**
   - Verify you count all archive `.md` files, not only `task-*.md`.

3. **Workers hit max-turn policy**
   - Ensure worker launch turn limit is not low in `team__create` payload.
   - Keep worker prompts constrained to msgq tools for queue operations.

4. **Sandbox log output path errors**
   - Prefer host redirection (`> tmp/e2e/... 2>&1`) for lead sandbox runs.
   - Or use a path under shared mount (`tmp/guinea-site/coordination/...`).
