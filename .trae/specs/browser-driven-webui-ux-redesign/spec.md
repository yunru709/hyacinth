# 基于浏览器审视的 WebUI 体验重设计 Spec

## Why
当前 WebUI 已经迁移了 TUI 的大部分能力到可视化控件，但在实际运行画面中仍存在初始化错误暴露生硬、信息层级重复、面板布局拥挤、图标语义不清、空态/错误态设计不足等问题。需要通过浏览器实际画面重新审视布局、交互与功能之间的匹配度，把控制台打磨成信息清晰、操作一致、错误可恢复的图形界面。

## What Changes
- WebUI SHALL 提供优雅且可操作的初始化/错误状态，不再用红色原始错误横幅阻断全部交互。
- WebUI SHALL 统一信息架构，减少 Header、ActivityRail、InspectorDrawer 之间的重复入口。
- WebUI SHALL 改进 ActivityRail 图标与标签，使其在图形界面中具备自解释性。
- WebUI SHALL 优化右侧面板内容布局，解决 300px 宽度下表单、表格、按钮拥挤的问题。
- WebUI SHALL 统一空态、加载态、错误态的视觉语言，每个面板都有明确指引。
- WebUI SHALL 改进命令面板的内容组织，让后端命令与前端面板/动作正确映射。
- WebUI SHALL 提供响应式兜底，确保在较小视口下主要功能仍可操作。

## Impact
- Affected specs: `redesign-webui-control-console`, `improve-webui-interactions`
- Affected code: `webui/src/App.tsx`, `webui/src/components/App*.tsx`, `webui/src/components/Sidebar.tsx`, `webui/src/components/ActivityRail.tsx`, `webui/src/components/InspectorDrawer.tsx`, `webui/src/components/Header.tsx`, `webui/src/components/InputArea.tsx`, `webui/src/components/ChatLog.tsx`, `webui/src/components/CommandPalette.tsx`, `webui/src/components/ModelCenterPanel.tsx`, `webui/src/components/SettingsPanel.tsx`, `webui/src/components/ContextPanel.tsx`, `webui/src/index.css`, `webui/src/store.ts`

## ADDED Requirements

### Requirement: Graceful Initialization & Error Recovery
The system SHALL display initialization failures in a way that explains the problem and offers recovery actions, instead of a raw red error banner and a blocking modal.

#### Scenario: Agent fails to initialize
- **WHEN** the WebUI connects but the Agent fails to initialize (e.g., EPERM creating session directory)
- **THEN** the UI shows a friendly error card with the error summary and actionable buttons such as "重试" / "打开设置" / "查看日志"
- **AND** the user can still browse sessions, open panels, and inspect configuration without a full-screen blocking overlay
- **AND** the chat input remains disabled with a clear reason until the Agent is ready

### Requirement: Unified Information Architecture
The system SHALL remove duplicate controls and consolidate related functions into single, predictable locations.

#### Scenario: Model information
- **WHEN** the user wants to view or change the current provider/model
- **THEN** the primary entry is the ActivityRail "模型" panel or the Header model chip (which opens the same panel)
- **AND** the Header no longer shows redundant model controls that duplicate the panel content

#### Scenario: Mode switching
- **WHEN** the user wants to switch Normal/Precise mode
- **THEN** there is one prominent mode toggle in the Header
- **AND** the mode is also reflected in the Session creation UI and the Model Center panel is only for model/provider settings

### Requirement: Self-Explaining Activity Rail
The system SHALL use icons and labels that clearly communicate each functional area.

#### Scenario: First-time user sees the rail
- **WHEN** a user opens WebUI for the first time
- **THEN** each rail button has a recognizable icon and a visible label or tooltip in Chinese
- **AND** the abstract geometric symbols (▣, ▥, ▤, ◷) are replaced or supplemented with more conventional iconography

### Requirement: Panel Layout Optimization
The system SHALL present panel content in a way that fits the available width and avoids cramped forms.

#### Scenario: Model Center panel
- **WHEN** the user opens the Model Center panel
- **THEN** sections are visually grouped with consistent spacing
- **AND** long forms use stacked layouts instead of multi-column grids that overflow 300px
- **AND** action buttons have adequate touch targets and clear hierarchy

#### Scenario: Settings panel
- **WHEN** the user opens Settings
- **THEN** related settings are grouped into expandable sections or tabs
- **AND** there is a single primary save action per section, not one save button per card

### Requirement: Empty, Loading & Error States
The system SHALL provide clear empty, loading, and error states for every panel.

#### Scenario: Panel with no data
- **WHEN** a panel has no data to display (e.g., no local models, no scheduler tasks, no knowledge results)
- **THEN** the UI shows an empty-state illustration or icon, a short Chinese explanation, and a primary action when applicable

#### Scenario: Panel API error
- **WHEN** a panel fails to load data from the backend
- **THEN** the UI shows a localized error message and a retry button
- **AND** the error does not propagate as a global toast unless it affects the whole application

### Requirement: Command Palette Content Mapping
The system SHALL map backend commands to frontend actions so that the command palette opens the correct panel or executes the correct action.

#### Scenario: User selects a panel-related command
- **WHEN** the user selects "模型中心", "知识库", "调度", "设置", or "上下文" from the command palette
- **THEN** the corresponding panel opens in the InspectorDrawer
- **AND** the ActivityRail highlights the active area

#### Scenario: User selects an action command
- **WHEN** the user selects "清屏", "帮助", or "折叠所有工具"
- **THEN** the action executes immediately without requiring slash command input

### Requirement: Responsive Fallback
The system SHALL degrade gracefully on smaller viewports.

#### Scenario: Narrow viewport
- **WHEN** the viewport width is below 1024px
- **THEN** the InspectorDrawer can be toggled as an overlay rather than a fixed column
- **AND** the Sidebar can be collapsed to give the chat area more space

## MODIFIED Requirements

### Requirement: Existing Header
The Header SHALL be simplified to show only essential status and navigation, removing duplicates of panel content.

### Requirement: Existing Initialization Overlay
The full-screen "初始化 Agent..." overlay SHALL be replaced with a non-blocking status indicator plus an error recovery card when initialization fails.

### Requirement: Existing ActivityRail
The ActivityRail SHALL keep the same functional areas but use clearer iconography and active-state semantics.

### Requirement: Existing InspectorDrawer Panels
The panels in InspectorDrawer SHALL be reorganized for better readability, consistent spacing, and clear primary/secondary actions.

## REMOVED Requirements

### Requirement: Raw Red Error Banner at Top
**Reason**: A raw error string at the top of the header is alarming, overlaps content, and offers no recovery path.
**Migration**: Replace with a dedicated error/recovery card inside the chat area or as a dismissible alert with actions.

### Requirement: Per-Card Save Buttons in Settings
**Reason**: Multiple "保存" buttons in a single panel create confusion about what is being saved and increase click cost.
**Migration**: Group settings into sections with one save action each, or auto-save with debounce and visual feedback.
