# WebUI Agent 控制台重设计 Spec

## Why
现有 WebUI 主要是聊天界面，只迁移了少量 TUI 常用命令；而 TUI 中大量能力仍依赖 slash command，在网页上不符合图形界面的使用习惯。需要把 TUI 的会话、模型、上下文、知识库、安全、修复、调度和队列等能力迁移为可视化控制台，同时保留聊天主流程的简洁性。

## What Changes
- WebUI SHALL 从单一聊天布局升级为 Agent 控制台布局：Activity Rail、功能侧栏、主聊天区、右侧 Inspector/Drawer。
- WebUI SHALL 把 TUI 中高频 slash command 能力转化为可视化入口，slash command 仅作为高级快捷方式保留。
- WebUI SHALL 提供 Context/Settings 面板，覆盖 maxContext、maxTurns、压缩策略、安全确认、日志、修复保护等配置项。
- WebUI SHALL 提供 Model Center 面板，展示当前 provider/model、本地模型状态、thinking 设置和模型通道管理入口。
- WebUI SHALL 提供 Knowledge 面板，覆盖 KB/Zone4 状态、统计和搜索。
- WebUI SHALL 提供 Scheduler 面板骨架，展示定时任务并支持新增任务入口。
- WebUI SHALL 在 Agent 正在处理时支持输入队列的可视化设计，先实现 UI 状态与协议预留，后续接入完整后端队列能力。
- 后端 WebUI Channel SHALL 补充最小 API，支持前端读取命令、配置和运行时状态，执行安全的配置更新。

## Impact
- Affected specs: WebUI interaction model, TUI capability migration, runtime settings, model management, knowledge panel, scheduler panel
- Affected code: `webui/src/App.tsx`, `webui/src/store.ts`, `webui/src/types.ts`, `webui/src/hooks/useWebSocket.ts`, `webui/src/components/*`, `webui/src/index.css`, `src/channels/builtin/webui-channel.ts`, `src/channels/builtin/webui-types.ts`, `src/channels/builtin/webui-ws-session.ts`

## ADDED Requirements
### Requirement: WebUI Control Console Layout
The system SHALL provide a WebUI layout with a persistent activity rail, a contextual sidebar, the main chat area, and an optional inspector/drawer for detailed controls.

#### Scenario: Navigate between WebUI functional areas
- **WHEN** the user selects Sessions, Models, Knowledge, Scheduler, Tools, or Settings from the activity rail
- **THEN** the corresponding sidebar or panel is displayed
- **AND** the chat conversation remains visible unless the selected panel intentionally opens a full-page view

### Requirement: Visual Replacement for TUI Slash Commands
The system SHALL expose common TUI slash command capabilities as visible WebUI controls.

#### Scenario: User changes runtime settings without slash commands
- **WHEN** the user opens Settings or Context panels
- **THEN** the user can update available settings through toggles, selects, sliders, and inputs
- **AND** the system applies supported settings through WebUI APIs

#### Scenario: User uses slash command as shortcut
- **WHEN** the user types an existing slash command in the chat input
- **THEN** existing command behavior MAY continue to work
- **AND** the same common action SHALL have a visible WebUI control where practical

### Requirement: Context and Settings Panels
The system SHALL provide panels for session context, compression, safety, logging, and repair guard settings.

#### Scenario: Inspect context usage
- **WHEN** the user clicks the context indicator or opens the Context panel
- **THEN** the UI displays tokens used, max tokens, cache hit rate, compression count, and editable context limits where supported

#### Scenario: Update safety and repair settings
- **WHEN** the user changes confirmation, scavenge, storm protection, storm window, or storm threshold settings
- **THEN** the UI sends a config patch request
- **AND** the new state is reflected in the panel after success

### Requirement: Model Center
The system SHALL provide a Model Center for current provider/model, online model selection, local model status, thinking settings, and model channel routing.

#### Scenario: Inspect current model state
- **WHEN** the user opens Model Center
- **THEN** the UI shows active provider, model, routing mode, local/online status, and thinking state where available

#### Scenario: Manage model channels visually
- **WHEN** model channel data is available
- **THEN** the UI presents channels and role mappings as tables/cards instead of requiring `/channel` commands

### Requirement: Knowledge Panel
The system SHALL provide a Knowledge panel for KB/Zone4 status, stats, and search.

#### Scenario: Search knowledge base
- **WHEN** the user enters a query in the Knowledge panel
- **THEN** the UI calls the knowledge query API
- **AND** displays ranked results or an empty-state message

### Requirement: Scheduler Panel
The system SHALL provide a Scheduler panel for scheduled tasks.

#### Scenario: View scheduled tasks
- **WHEN** the user opens Scheduler
- **THEN** the UI displays active scheduled tasks, disabled/expired counts when available, and an add-task entry point

### Requirement: Queue-Aware Chat Input
The system SHALL provide a WebUI input experience that does not simply disable input while the Agent is processing.

#### Scenario: Agent is processing
- **WHEN** the user types while processing is active
- **THEN** the UI offers Queue, Insert/Interrupt, and Stop actions
- **AND** queued items are visible in a queue strip or drawer

### Requirement: WebUI Runtime APIs
The WebUI backend SHALL expose minimal APIs for control panels to read command metadata, runtime config, and status, and to apply safe config updates.

#### Scenario: Frontend loads control data
- **WHEN** WebUI connects
- **THEN** it can load commands, config, status, capabilities, and knowledge stats without relying on chat messages

## MODIFIED Requirements
### Requirement: Existing WebUI Layout
The existing WebUI chat layout SHALL be modified so that chat remains the primary surface, while operational controls move into dedicated panels and drawers.

### Requirement: Existing WebUI Slash Commands
Slash commands SHALL remain available as shortcuts, but SHALL NOT be the primary UI for common operations on WebUI.

### Requirement: Existing Permission UI
Permission prompts SHALL be displayed as a prominent modal or bottom sheet with clear Yes, Always, and No actions, while preserving keyboard shortcuts.

## REMOVED Requirements
### Requirement: Processing Disables All Input
**Reason**: TUI supports message queueing and insert-mode during processing; disabling input makes WebUI less capable than TUI.
**Migration**: Replace the disabled input behavior with queue-aware controls while retaining Stop as an immediate action.
