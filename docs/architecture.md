# System Architecture

## Overview

Agent is a modular AI agent framework with multi-provider LLM support, hierarchical context management, tool execution, plugin/skill systems, and multi-agent collaboration. The core loop is: **compose context -> LLM inference -> parse output -> execute tools -> repeat**.

```
                   ┌─────────────────────────────┐
                   │      Gateway Layer           │
                   │  CLI / TUI / HTTP Server     │
                   └──────────┬──────────────────┘
                              │
                   ┌──────────▼──────────────────┐
                   │      AgentLoop               │
                   │  compose → LLM → parse → tool│
                   └──────────┬──────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
   ┌─────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐
   │  Context   │      │   Provider   │     │    Tools     │
   │  Composer  │      │   (LLM)     │     │  Read/Write  │
   │  L0-L4     │      │ 6 backends  │     │  Edit/Bash   │
   └───────────┘      └─────────────┘     │  Glob/Skill  │
                                          │  MCP/Agent   │
                                          └─────────────┘
```

## Module Map

### 1. Gateway Layer
Entry points that initialize the system and handle user interaction.

| Module | File | Role |
|--------|------|------|
| CLI | `gateway/cli.ts` | Commander-based CLI, interactive/repl mode, session management |
| TUI | `gateway/tui.ts` | Neo-blessed full-screen terminal UI |
| HTTP API | `gateway/server.ts` | Fastify HTTP server, 8 REST endpoints |
| Factory | `gateway/factory.ts` | Shared `createAgent()` init, eliminates duplication across gateways |

### 2. Orchestrator
The core agent loop and planning system.

- **AgentLoop** (`orchestrator/loop.ts`): Main loop — compose context, call LLM, parse stream events, execute tools, repeat. Supports `normal` and `precise` scheduling modes.
- **LLMOrchestrator** (`orchestrator/planner.ts`): Plan-based orchestration — assesses task, creates plan, tracks progress.
- **PlanStore** (`orchestrator/plan-store.ts`): Plan CRUD with status tracking per step.

### 3. Context System (L0-L4)

```
Zone 1: Persistent identity/system prompts (always included)
Zone 2: Manifest index of available tools/skills/agents (always included)
Zone 3: Lazy-expand definitions (tools/skills/agents on demand)
Zone 4: Conversation history (most recent messages)
```

| Component | File | Role |
|-----------|------|------|
| LayeredContextComposer | `context/composer.ts` | Assembles L0-L4 zones, supports normal/precise modes |
| CompressorOrchestrator | `context/compressor.ts` | Context compression via summarization |
| StructuredSummarizer | `context/compressor.ts` | LLM-powered structured summarization |
| TokenCounter | `context/tokenizer.ts` | Token counting via js-tiktoken |
| PromptBuilder | `context/prompt-builder.ts` | Assembles final prompt array from zones |
| ContextModes | `context/modes.ts` | Normal vs precise scheduling mode logic |

### 4. Provider Layer
Unified LLM interface with 6 backend implementations.

- **Interface** (`provider/interface.ts`): `Provider` abstract with `createStream()`
- **AnthropicProvider**: Claude models via Anthropic SDK
- **OpenAIProvider**: GPT models via OpenAI SDK
- **DeepSeekProvider**: DeepSeek models
- **LocalProvider**: Local models (llama.cpp, ollama, etc.)
- **OpenAICompatibleProvider**: Groq, xAI, Mistral, OpenRouter, Moonshot
- **GeminiProvider**: Google Gemini via @google/genai SDK
- **ResilientProvider**: Retry (exponential backoff) + Circuit breaker (3-state) wrapper
- **FallbackProviderChain**: Sequential fallback across multiple providers
- **ProviderManager**: Auto-detection, config file loading, env var resolution
- **ModelCatalog**: Model metadata, capabilities, cost info

### 5. Tool System
Registry-based tool execution with sandbox support.

| Tool | File | Description |
|------|------|-------------|
| ReadTool | `tools/read.ts` | Read files with line numbers, offset/limit |
| WriteTool | `tools/write.ts` | Write/create files, auto-create dirs |
| EditTool | `tools/edit.ts` | String replacement in files |
| BashTool | `tools/bash.ts` | Shell command execution with optional sandbox |
| GlobTool | `tools/glob.ts` | File pattern matching |
| SkillTool | `skills/skill-tool.ts` | Invoke registered skills |
| DelegateToAgentTool | `agents/delegate-tool.ts` | Delegate tasks to sub-agents |

- **ToolRegistry**: Register/lookup tools
- **FilteredToolRegistry**: Tool whitelisting for sub-agents
- **ToolExecutor**: Execute tool calls with error handling

### 6. Memory & Persistence

| Component | File | Storage |
|-----------|------|---------|
| ConversationStore | `memory/conversation.ts` | JSONL, auto-truncation |
| EventStore | `memory/events.ts` | JSONL |
| StatsManager | `memory/stats.ts` | JSON |
| SummaryStore | `memory/summary.ts` | Markdown |
| SessionManager | `memory/session.ts` | Directory-based under `~/.agent/sessions/` |

### 7. Sub-Agent System

- **AgentRegistry**: Register/lookup agent definitions
- **Built-in agents**: code-reviewer, security-auditor, test-writer
- **DelegateToAgentTool**: 3 collaboration modes
  - `delegate`: Single sub-agent, single session
  - `adversarial`: Two agents independently review, results merged
  - `parallel`: Multiple agents via Promise.all
- **FilteredToolRegistry**: Per-agent tool whitelisting

### 8. MCP (Model Context Protocol)

| Component | File | Description |
|-----------|------|-------------|
| MCPClient | `mcp/client.ts` | stdio + SSE transport, tool discovery |
| MCPBridge | `mcp/bridge.ts` | Multi-client bridge to ToolRegistry |
| MCPConfigLoader | `mcp/config.ts` | Load from `.agent/mcp.json` or `.mcp.json` |
| MCPServerManager | `mcp/lifecycle.ts` | Process lifecycle, auto-restart, health check |

### 9. Plugin System

- **PluginManager**: discover -> load -> activate -> connect MCP -> register skills
- **PluginLoader**: Scan directories, load manifests, dynamic import
- **PluginApi**: registerTool/registerSkill/registerContextSource/registerMcpServer

### 10. Skills

- **SkillRegistry**: Register/lookup, index/full-definitions generation
- **File-based skills**: Load from `~/.agent/skills/*.md` and `.agent/skills/*.md`
- **Hot-reload**: `fs.watch` with 500ms debounce on skill directories
- **Built-in skills**: code-review, debug, refactor

### 11. Schedule System

- **HeartbeatScheduler**: Configurable heartbeat loop
- **Schedule types**: interval, cron (5-field), daily (HH:mm), fixed-time (ISO)
- **Persistence**: JSON storage at `~/.agent/scheduler/tasks.json`

### 12. Lifecycle Management

- **ProcessManager**: spawn/stop/restart, health check (HTTP/TCP), crash auto-recovery
- **LocalModelManager**: Auto-detect local model backends (llama.cpp, ollama, etc.)
- **LifecycleSupervisor**: Signal handling, managed entity registration, graceful shutdown

### 13. Other Modules

| Module | File | Description |
|--------|------|-------------|
| Parser | `parser/router.ts` | Routes stream events (text/thinking/tool_use) |
| Dependency | `dependency/` | Import graph analysis, change impact assessment |
| Logging | `logging/logger.ts` | ConsoleLogger, 5 levels, msg-first, JSON to stderr |
| Setup | `setup/` | ConfigManager + SetupWizard for first-run |
| Prompts | `prompts/` | System prompt templates (identity, safety, tools, orchestration) |

## Data Flow

```
User Input
    │
    ▼
AgentLoop.run()
    │
    ├─► ContextComposer.compose() → [Zone1..Zone4]
    │      Zone1: Identity + safety prompts
    │      Zone2: Tool/skill/agent index
    │      Zone3: Expanded definitions
    │      Zone4: Conversation history
    │
    ├─► Provider.createStream() → StreamEvent[]
    │      ├─ TEXT → OutputHandler.onText()
    │      ├─ THINKING → OutputHandler.onThinking()
    │      ├─ TOOL_USE → OutputHandler.onToolUse()
    │      │      └─ ToolExecutor.execute() → ToolResult
    │      │             └─ OutputHandler.onToolResult()
    │      ├─ USAGE → StatsManager.update()
    │      └─ STOP → turn complete
    │
    ├─► ConversationStore.append() (persist)
    │
    └─► Repeat until maxTurns or STOP
```

## Error Recovery

```
Provider chain:
  Primary Provider
    └─ ResilientProvider (retry 4×, exponential backoff)
         └─ Circuit Breaker (5 failures → open 30s)
              └─ FallbackProviderChain → next provider
```

## Key Design Decisions

1. **msg-first logging**: `logger.info('message', { context })` — human-readable first, structured second
2. **Async generator streams**: `async *createStream()` for unified streaming across all providers
3. **Context zones over sliding window**: L0-L4 enables precise control over what stays vs. what compresses
4. **Sub-agent isolation**: Each sub-agent gets its own session directory under `sub-agents/{name}-{id}/`
5. **Plugin-host co-location**: Plugins load in-process via dynamic import (no sandbox isolation yet)