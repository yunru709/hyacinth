# WebUI 交互化改造 Spec

## Why
当前 TUI 通过 slash command 暴露了大量能力，但 WebUI 仍主要依赖少量命令和简化控件，用户体验不符合图形界面的预期。同时 WebUI 新建 session 后不会自动切换后端会话，且缺少 normal/precise 类型选择，容易造成会话归属和当前会话显示混乱。

## What Changes
- WebUI 新建 session SHALL 提供 normal/precise 类型选择，并在创建后自动切换到新 session。
- WebUI Sidebar SHALL 不再把未知渠道 session 默认归类为 TUI，而是显示为 unknown/legacy。
- WebUI SHALL 把高频 TUI 命令转为可视化交互入口，优先覆盖清屏、工具折叠、帮助、模式切换、基础设置。
- 后端 WebUI Channel SHALL 提供支持 session 类型参数的创建接口。
- 后端 WebSocket session SHALL 支持 precise 模式以 session 语义切换，而不是仅切换 compose strategy。

## Impact
- Affected specs: WebUI session management, WebUI command interaction, precise mode switching
- Affected code: `webui/src/components/Sidebar.tsx`, `webui/src/components/Header.tsx`, `webui/src/components/ChatLog.tsx`, `webui/src/hooks/useWebSocket.ts`, `webui/src/store.ts`, `src/channels/builtin/webui-channel.ts`, `src/channels/builtin/webui-ws-session.ts`, `src/channels/builtin/webui-types.ts`

## ADDED Requirements
### Requirement: WebUI Session Creation Options
The system SHALL allow WebUI users to choose session type when creating a session.

#### Scenario: Create normal session
- **WHEN** the user chooses to create a normal session in WebUI
- **THEN** the backend creates a normal session with channel `webui`
- **AND** the frontend switches the active WebSocket session to the newly created session
- **AND** the chat view resets to the new session state

#### Scenario: Create precise session
- **WHEN** the user chooses to create a precise session in WebUI
- **THEN** the backend creates or returns a precise session with channel `webui`
- **AND** the frontend switches the active WebSocket session to that precise session
- **AND** the UI indicates precise mode is active

### Requirement: WebUI Channel Classification
The system SHALL classify sessions using explicit `channel` metadata when available and SHALL NOT default unknown sessions to TUI.

#### Scenario: Session without channel metadata
- **WHEN** a session has no `channel` and no recognizable prefix
- **THEN** WebUI displays it under `Legacy` or `Unknown`
- **AND** it does not appear under TUI by default

### Requirement: Visual Interaction for Common Commands
The system SHALL expose common TUI command capabilities through WebUI controls instead of requiring slash command input.

#### Scenario: Chat toolbar actions
- **WHEN** the user opens chat toolbar controls
- **THEN** the user can clear the visible chat log
- **AND** toggle all tool cards collapsed or expanded
- **AND** open help information without typing `/help`

#### Scenario: Mode switch
- **WHEN** the user toggles Normal/Precise mode in WebUI
- **THEN** the backend performs the corresponding session-aware mode switch
- **AND** the current session indicator updates consistently

## MODIFIED Requirements
### Requirement: Existing WebUI Slash Commands
WebUI MAY keep slash commands as shortcuts, but common actions SHALL have equivalent visible controls.

### Requirement: Existing Precise Mode Handling
Precise mode in WebUI SHALL align with TUI behavior by switching to a precise session where appropriate, rather than only replacing the compose strategy on the current session.

## REMOVED Requirements
### Requirement: Unknown Session Defaults To TUI
**Reason**: Defaulting unknown sessions to TUI misrepresents WebUI-created or legacy sessions when metadata is incomplete.
**Migration**: Sessions without explicit metadata are shown as Legacy/Unknown until their metadata can be inferred or updated.
