# Agent Template Schema (since `daemon/v1`)

This document describes the schema for **Agent Templates** used by the daemon-compatible family of AI agent systems. 

## Agent Templates vs. Session Templates

It is important to distinguish between these two concepts:

1.  **Agent Templates**: These are the "Classes" or blueprints. They are static YAML files stored in `agent/templates/*.yaml`. They define the default configuration, tools, and system prompt for a specific type of agent.
2.  **Session Templates (Instances)**: These are the "Instances" of an agent. When an Agent Template is instantiated, it becomes a Session. Sessions are stored in `db/sessions/` (or `agents/sessions/` in older versions) and include all the information from the Agent Template plus runtime state such as message history, status, usage metrics, and process IDs.

## File Format
Agent Templates are written in **YAML** and typically stored in `agent/templates/*.yaml`.

## Schema Overview

```yaml
apiVersion: daemon/v1
kind: Agent
metadata:
  name: <string>          # Unique identifier for the template
  description: <string>   # Human-readable description of the agent
  model: <string>         # AI model (e.g., copilot:gpt-4o, xai:grok-4-fast-reasoning)
  tools:                  # List of tool IDs the agent can access
    - <tool_id>
  labels:                 # Optional labels for categorization
    - <label>
spec:
  system_prompt: |        # System instructions for the AI (supports EJS)
    You are a helpful assistant...
```

## Field Definitions

### `apiVersion` (Required)
Must be `daemon/v1`.

### `kind` (Required)
Must be `Agent`.

### `metadata` (Required)
Contains identification and configuration for the agent.

- **`name`**: The unique name of the template. If omitted in the file, it is often inferred from the filename.
- **`description`**: A brief explanation of what the agent does.
- **`model`**: The model string in the format `provider:model-name`.
    - Examples: `copilot:gpt-4o`, `anthropic:claude-3-5-sonnet`, `xai:grok-4-fast-reasoning`, `ollama:llama3`.
- **`tools`**: An array of tool identifiers. Tools are usually named as `plugin__category__action` (e.g., `fs__file__read`, `shell__execute`).
- **`labels`**: An array of strings used to tag agents (e.g., `subagent`, `specialized`).

### `spec` (Required)
Contains the operational logic of the agent.

- **`system_prompt`**: The core instructions for the AI. 
    - **EJS Support**: The `system_prompt` is evaluated as an EJS template within the agent's container. It has access to:
        - `process`: The Node.js process object (e.g., `<%= process.platform %>`, `<%= process.cwd() %>`).
        - `os`: The Node.js OS module (e.g., `<%= os.release() %>`).
        - `new Date()`: For dynamic dates.

## Example Template

```yaml
apiVersion: daemon/v1
kind: Agent
metadata:
  name: researcher
  description: Specialized agent for web research
  model: copilot:gpt-4o
  tools:
    - web__search
    - web__fetch
  labels:
    - subagent
spec:
  system_prompt: |
    You are a Web Research Assistant. 
    Current Date: <%= new Date().toLocaleDateString() %>
    Operating System: <%= process.platform %>
    
    Use web__search to find information and web__fetch to read pages.
```

## Instantiation Process (Template to Session)

When an **Agent Template** is copied to create a **Session**, several transformations occur:

1.  **Metadata Initialization**:
    *   `metadata.id`: Assigned a unique numeric ID.
    *   `metadata.containerId`: Generated as `{sessionId}_{unixTimestamp}`.
    *   `metadata.created`: Set to the current ISO timestamp.
    *   `metadata.status`: Initialized to `pending`.
2.  **Tool Normalization**:
    *   If `spec.tools` exists in the template, it is moved to `metadata.tools`.
    *   `spec.tools` is explicitly **deleted** from the session instance to keep the spec clean.
3.  **System Prompt Rendering**:
    *   The `spec.system_prompt` is treated as an EJS template.
    *   It is rendered using the container's environment context (`os`, `process`).
    *   The original EJS template string is replaced by the **final rendered string** in the session YAML.
4.  **Message History**:
    *   `spec.messages` is initialized as an array (usually empty) to track the conversation.

## Session Templates (Runtime Instances)
When an Agent Template is instantiated into a **Session**, the schema is extended with runtime data. You can find examples of these in `db/sessions/*.yaml`.

Common additional fields in Sessions include:

- **`metadata.status`**: The current state of the session (`pending`, `running`, `success`, `error`, `paused`, `stopped`).
- **`metadata.id`**: The unique session ID.
- **`metadata.pid`**: The process ID of the running agent.
- **`metadata.usage`**: Token usage statistics (`prompt_tokens`, `completion_tokens`, etc.).
- **`metadata.last_read`**: Timestamp of the last time the session was accessed.
- **`spec.messages`**: An array of message objects representing the full conversation history.
    - Each message has `role` (`user`, `assistant`, or `tool`) and `content`.
    - Assistant messages may contain `tool_calls`.
    - Tool messages contain `tool_call_id` and `content` (the output of the tool).

## Session ID Format

The `session_id` (stored in `metadata.id`) follows these rules:

- **Numeric**: It is an integer (represented as a string).
- **Zero-indexed**: IDs are sequential integers starting from 0.
- **Globally Unique**: Each session ID is unique across the entire system.

## Message Examples (`spec.messages`)

### User Message
```yaml
- role: user
  content: "List the files in the current directory"
```

### Assistant Message (with Tool Call)
```yaml
- role: assistant
  content: null
  tool_calls:
    - id: call_abc123
      type: function
      function:
        name: fs__directory__list
        arguments: '{"path": "."}'
```

### Tool Response Message
```yaml
- role: tool
  tool_call_id: call_abc123
  content: "[\"README.md\", \"src/\", \"package.json\"]"
```

