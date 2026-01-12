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

## Features

- **Template Support**: Uses EJS for dynamic system prompts (e.g., `<%= word %>`).
- **Unix Philosophy**: Non-final logs go to `stderr`; final agent response goes to `stdout` for easy piping.
- **Tool Calling**: Supports a wide range of tools (fs, shell, web, etc.).
- **Session History**: Automatically saves session history in `agent/sessions/`.
- **xAI Integration**: Currently supports xAI (Grok) as the primary provider.

