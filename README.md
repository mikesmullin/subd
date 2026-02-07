# subdaemon (subd)

An agentic CLI tool powered by xAI.

## Installation

```bash
bun install
bun link
```

## Usage

```bash
subd -t <template.yaml> [-d <yaml_data>] [-o output.log] [-v] [-l <turns>] <prompt...>
```

### Options

- `-t`: (Required) Input agent system prompt template YAML.
- `-d`: (Optional) Input data (expects YAML flow syntax); used to provide values for EJS template replacement.
- `-o`: (Optional) Output file. If not provided, output is written to stdout.
- `-v`: (Optional) Verbose mode. Prints performance stats, thoughts, and tool results to stderr.
- `-j`: (Optional) JSONL output mode. Every line logged is wrapped in a JSON object for machine parsing.
- `-l`: (Optional) Limit the number of AI turns before exiting. Useful for single-shot tool execution.
- `prompt...`: (Required) The initial user prompt.

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

