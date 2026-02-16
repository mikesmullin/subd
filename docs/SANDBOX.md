# SANDBOX

This document explains `subd` sandbox execution and host bridging.

## Flags Overview

- `-s`: sandbox mode (host process starts containerized agent run)
- `-a`: agent/container mode (internal flag for process running inside container)

Typical flow:

1. User runs `subd ... -s` on host.
2. Host starts a TCP bridge server.
3. Host launches container with bridge env vars and `-a`.
4. Containerized `subd` routes selected requests to host.

## Why This Exists

Sandbox mode isolates agent execution, but some capabilities must stay host-side:

- host-only binaries
- host-only credentials/secrets
- canonical persistence and policy enforcement

## Bridge Responsibilities

The host bridge can serve:

- template resolution
- AI completion requests
- host tool calls (`tool_call`)
- host-side session persistence (`session_save`)
- cmd-proxy execution streams (`cmd_proxy_exec_start`, stdin/stdout/stderr/exit)

## `cmd_proxy` Concept

`cmd_proxy` enables safe host execution of selected commands from sandbox.

Example pattern:

- In container, `jira` points to `cmd_proxy`.
- `cmd_proxy` sends command+args to host bridge.
- Host validates against a dedicated `cmd_proxy` allowlist.
- If approved, host executes real command and streams output back.

This keeps host binary implementation and secrets out of container context.

## Allowlist Separation (Important)

Two different allowlists serve different trust boundaries:

1. `shell__execute.allowlist`
   - controls what command names can be invoked in container shell tool
2. `cmd_proxy.allowlist`
   - controls which proxied host commands are executable on host

Keep them separate and minimal.

## Template Snippet

```yaml
metadata:
  cmd_proxy:
    allowlist:
      jira: true
  tools:
    - shell__execute:
        allowlist:
          jira: true
```

## Session Persistence in `-a`

In container mode, session YAML writes should route through host (`session_save`) so host remains source of truth for:

- observability
- debugging
- deterministic history location

## Operational Tips

- Build sandbox image before use: `podman build -t subd:latest .`
- Keep host bridge token ephemeral per run.
- Treat proxied command set as high-risk surface; default-deny everything not needed.
