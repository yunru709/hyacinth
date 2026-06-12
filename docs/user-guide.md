# User Guide

## Installation

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Link CLI globally
npm link  # or: node dist/index.js
```

## Quick Start

```bash
# Set up API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run in interactive mode
agent

# Run a one-shot prompt
agent "Explain the architecture of this project"

# Run with explicit provider and model
agent -p openai -m gpt-4o "Review this code"
```

## CLI Commands

### Basic Usage

```
agent [options] [prompt]
```

| Option | Short | Description |
|--------|-------|-------------|
| `--provider <type>` | `-p` | Provider: anthropic, openai, deepseek, local, groq, xai, mistral, openrouter, gemini, moonshot |
| `--model <name>` | `-m` | Model name (defaults per provider) |
| `--interactive` | `-i` | Force interactive mode |
| `--tui` | | Full-screen terminal UI |
| `--max-turns <n>` | | Max turns (default: 40) |
| `--max-context <n>` | | Max context tokens (default: 200000) |
| `--continue` | | Resume most recent session |
| `--session <id>` | | Resume specific session |
| `--start-model` | | Start local model server |
| `--skip-setup` | | Skip first-run setup wizard |

### Subcommands

#### Setup Wizard

```bash
agent setup
```

Interactive first-run configuration: API keys, default provider, model preferences.

#### HTTP Server

```bash
agent serve --port 3000 --provider anthropic
```

Start the REST API server. See [API Reference](api.md) for endpoint details.

#### Session Management

```bash
# List sessions for current project
agent session list

# List sessions for a specific project
agent session list --project /path/to/project

# Delete a session
agent session delete 20260524-182358-c11f

# Export session as JSON
agent session export 20260524-182358-c11f -o ./session-backup.json
```

## Configuration

### Environment Variables

| Variable | Required For |
|----------|--------------|
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `OPENAI_API_KEY` | OpenAI provider |
| `DEEPSEEK_API_KEY` | DeepSeek provider |
| `GROQ_API_KEY` | Groq provider |
| `XAI_API_KEY` | xAI provider |
| `MISTRAL_API_KEY` | Mistral provider |
| `OPENROUTER_API_KEY` | OpenRouter provider |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini provider |
| `MOONSHOT_API_KEY` | Moonshot provider |
| `LOG_LEVEL` | Log level: debug, info, warn, error, off (default: info) |

### Config File

Place `.agent/config.json` in your project directory:

```json
{
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514"
  },
  "maxTurns": 40,
  "maxContext": 200000
}
```

### MCP Servers

Configure MCP tools in `.agent/mcp.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": { "KEY": "value" }
    },
    "remote-server": {
      "url": "https://example.com/sse",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

## Custom Skills

Create `.md` files with YAML frontmatter in `~/.agent/skills/` (user-level) or `.agent/skills/` (project-level). Project skills override user skills with the same name.

```markdown
---
name: my-skill
description: A custom skill for my workflow
tools: read, bash, glob
---

Perform the following task based on the user's request:

{{task}}

Focus on accuracy and completeness.
```

Skills are hot-reloaded automatically — just save the file.

## Provider Fallback

Configure provider fallback chain in `.agent/config.json`:

```json
{
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "fallbacks": [
      { "type": "openai", "model": "gpt-4o" },
      { "type": "deepseek", "model": "deepseek-chat" }
    ]
  }
}
```

When the primary provider fails (after retry + circuit breaker), the system automatically tries fallbacks in order.

## Sub-Agent Delegation

The built-in sub-agents are available as tools:

| Agent | Role |
|-------|------|
| `code-reviewer` | Review code for bugs and style issues |
| `security-auditor` | Audit code for security vulnerabilities |
| `test-writer` | Write and improve tests |

Invoke them by asking the agent: "Have code-reviewer review this file" or "Ask test-writer to write tests for this module."

Three collaboration modes:
- **Delegate**: Single agent handles the task
- **Adversarial**: Two agents independently review, results are merged
- **Parallel**: Multiple agents work simultaneously

## Local Models

```bash
# Start a local model and use it
agent --provider local --start-model --model "qwen2.5-coder:7b"

# Or start local model server first, then connect
agent --provider local
```

Supports llama.cpp, ollama, text-generation-webui, and vllm backends.

## Plugins

Place plugin directories in `.agent/plugins/`. Each plugin requires:
- `manifest.json` (metadata)
- Entry module (default: `index.ts`)

Example plugin structure:

```
.agent/plugins/my-plugin/
├── manifest.json
└── index.ts
```

## Troubleshooting

- **"No sessions found"**: Run at least one interaction first, or create a session explicitly.
- **Provider errors**: Check `LOG_LEVEL=debug` for detailed logs. Verify API keys in environment.
- **MCP connection failures**: Confirm the server command/URL is correct and the server is running.
- **Tests**: Run `pnpm test` to verify system health (138+ tests).