# subdaemon (subd)

An agentic CLI tool powered by xAI.

## Installation

```bash
bun install
bun link
```

## Usage

```bash
subd -t <template.yaml> [-d <yaml_data>] [-o output.log] [-v] [-l <turns>] [-s] [-V <host_path:container_path[:options]> ...] [--volume <host_path:container_path[:options]> ...] <prompt...>
```

### Options

- `-t`: (Required) Input agent system prompt template YAML.
- `-d`: (Optional) Input data (expects YAML flow syntax); used to provide values for EJS template replacement.
- `-o`: (Optional) Output file. If not provided, output is written to stdout.
- `-v`: (Optional) Verbose mode. Prints performance stats, thoughts, and tool results to stderr.
- `-j`: (Optional) JSONL output mode. Every line logged is wrapped in a JSON object for machine parsing.
- `-l`: (Optional) Limit the number of AI turns before exiting. Useful for single-shot tool execution.
- `-s`: (Optional) Sandbox mode. Runs the agent in a Podman container and enables host-bridge socket routing for sandbox-aware tools.
- `-V`: (Optional, repeatable) Shorthand alias for `--volume`.
- `--volume`: (Optional, repeatable) Bind mount passed to `podman run -v`. Format: `<host_path>:<container_path>[:options]`. Useful for sharing a workspace path (for example `tmp/guinea-site`) across lead + worker sandbox containers.

When a mount targets `/workspace/subd/...`, `subd` automatically adds a compatibility alias mount to `/app/...` for the same host path. This ensures relative paths like `tmp/guinea-site/...` (resolved from container working dir `/app`) still land on the shared host volume.

For Podman runtimes, sandbox launches use `--userns=keep-id` (and `--user <host_uid>:<host_gid>` when available) so bind-mounted files are owned/writable by the host user without routine `podman unshare` cleanup.
- `-a`: (Internal) Agent/container mode. Set automatically for the process running inside a sandbox container; not intended for normal manual use.
- `prompt...`: (Required) The initial user prompt.

### Sandbox Container (via Podman)

Build the sandbox image once (or after code/dependency changes):

```bash
podman build -t subd:latest .
```

`-s` mode uses this image via `podman run`.

### `cmd_proxy` in Sandbox Mode

Some CLIs (`jira` in this example) may require host-only binaries (to prevent llm from decompiling/modification) or host-only secrets files (to prevent llm from reading). In `-s` mode, you can expose those commands safely to the containerized agent via `cmd_proxy`:

- Inside the container, `jira` is a symlink to `cmd_proxy`.
- `cmd_proxy` forwards command + args over the sandbox bridge socket to the host `subd` process.
- The host `subd` process checks a dedicated `cmd_proxy` allowlist.
- If allowed, host executes the real command and streams `stdout`/`stderr` back to `cmd_proxy`, which exits with the same exit code.

This keeps the real host binary and secrets outside the container while still allowing normal shell usage from the agent.

#### Template Configuration (`cmd_proxy` allowlist)

Use a separate allowlist in template metadata:

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

Notes:

- `shell__execute.allowlist` controls what can be invoked inside the container shell.
- `cmd_proxy.allowlist` controls what proxied commands may execute on the host.
- (Recommended) Keep `cmd_proxy.allowlist` minimal (severely constrained) for security.

### Example: Automated Processing

`subd` is designed for automation. You can inject data into templates and pipe results through standard Unix tools.

**Template (`haiku.yaml`):**
```yaml
spec:
  system_prompt: "You are a poet. Generate a haiku about <%= word %>."
```

**Batch Invocation:**
```bash
echo "ocean\nforest\nsky" | xargs -I {} subd -t haiku -d "{word: '{}'}" "Generate"
```

**Sample Output:**
```text
Blue waves kiss the sand,
Whispers of the deep salt sea,
Tides return to home.

Green leaves dance in wind,
Ancient giants stand so tall,
Shadows breathe and grow.

Endless blue above,
Clouds like white ships sailing by,
Sunlight warms the air.
```

### JSONL Output Mode

When using `-j` flag, all output is wrapped in JSON objects (one per line) for machine parsing. Each line contains:

- `type`: The type of output (see below)
- `timestamp`: ISO 8601 timestamp
- Additional fields depending on type

**Output Types:**

| Type | Stream | Description |
|------|--------|-------------|
| `system_prompt` | stderr | The rendered system prompt |
| `user_prompt` | stderr | The initial user prompt |
| `assistant` | stderr | Intermediate assistant responses (verbose) |
| `tool_call` | stderr | Tool invocation with name and arguments |
| `tool_result` | stderr | Tool execution result |
| `thoughts` | stderr | AI reasoning/thinking content |
| `perf` | stderr | Performance metrics |
| `log` | stderr | General log messages |
| `error` | stderr | Error messages with code |
| `final` | stdout | Final assistant response |

**Example:**
```bash
subd -t haiku -j "Write a haiku" 2>&1 | jq -c 'select(.type == "final")'
```

## Features

- **Template Support**: Uses EJS for dynamic system prompts (e.g., `<%= word %>`).
- **Unix Philosophy**: Non-final logs go to `stderr`; final agent response goes to `stdout` for easy piping.
- **Tool Calling**: Supports a wide range of tools (fs, shell, web, etc.).
- **Session History**: Automatically saves session history in `agent/sessions/`.
- **xAI Integration**: Currently supports xAI (Grok) as the primary provider.

