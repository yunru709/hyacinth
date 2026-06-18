# 多 Session 状态隔离 Spec

## Why
当前多个 AgentLoop（WebUI 多标签页、WebUI + TUI 并存）共享同一个 Provider 实例和同一个 RuntimeConfigCenter 单例。一个 session 切换 provider 或 thinking 模式时，会通过 `configCenter.set('provider.active')` 全局广播，导致所有其他 session 被迫切换。同时 SessionManager 在同一进程内被多次实例化，读写同一文件系统而无协调机制。

## What Changes
- AgentLoop.switchProvider SHALL NOT 写入 `configCenter.set('provider.active')` 和 `configCenter.save()`，provider 切换仅影响当前 AgentLoop。
- AgentLoop SHALL 在每次调用 LLM 前应用自身的 thinking 状态到 provider，而非仅在初始化时设置一次。
- `watch('provider.active')` 订阅 SHALL 保留，但仅响应外部配置文件变更（config.json 热重载），不响应内部 switchProvider。
- `createAgent` SHALL 接受外部注入的 SessionManager 实例，而非每次内部 `new SessionManager()`。
- `server.ts` SHALL 创建唯一的 SessionManager 并注入到 agentFactory 和所有渠道。
- **BREAKING**: `switchProvider` 不再持久化 provider 选择到 config.json。TUI 的 `/model` 命令如需持久化，需显式调用 `configCenter.set` + `save`。

## Impact
- Affected specs: multi-session isolation, provider switching, thinking mode, session management
- Affected code: `src/orchestrator/loop.ts`（switchProvider、subscribeConfig、thinking 应用点、构造函数）, `src/gateway/factory.ts`（createAgent 接受 SessionManager 参数）, `src/gateway/server.ts`（创建并注入 SessionManager）, `src/gateway/tui.ts`（如需持久化 provider 选择）, `src/channels/builtin/webui-ws-session.ts`（使用注入的 SessionManager 而非 new）

## ADDED Requirements

### Requirement: Provider 切换局部化
AgentLoop.switchProvider SHALL 仅修改当前 AgentLoop 内部的 provider 引用、providerRouter、modelRouter，SHALL NOT 调用 `configCenter.set('provider.active')` 或 `configCenter.save()`。

#### Scenario: WebUI session A 切换 provider
- **WHEN** WebUI session A 调用 switchProvider('deepseek')
- **THEN** session A 的 provider 切换到 deepseek
- **AND** session B 的 provider 保持不变
- **AND** config.json 中的 `provider.active` 不被修改

#### Scenario: 外部编辑 config.json 切换 provider
- **WHEN** 用户手动编辑 config.json 将 `provider.active` 改为 'openai'
- **AND** configCenter 热重载检测到变更
- **THEN** 所有 AgentLoop 的 `watch('provider.active')` 回调被触发
- **AND** 每个 AgentLoop 尝试切换到 openai（如果其 providerRouter 中有该 provider）

### Requirement: Per-turn Thinking 状态应用
AgentLoop SHALL 在每次调用 `provider.createStream()` 之前，将自身的 `thinkingEnabled` 和 `thinkingEffort` 应用到当前 active provider，确保共享 provider 在被使用时具有正确的 thinking 状态。

#### Scenario: Session A 开启 thinking，Session B 关闭 thinking
- **WHEN** session A 开启 thinking 后发起对话
- **THEN** session A 的 LLM 调用使用 thinking 模式
- **WHEN** session B（未开启 thinking）发起对话
- **THEN** session B 的 LLM 调用不使用 thinking 模式
- **AND** 两个 session 的 thinking 状态互不干扰

### Requirement: SessionManager 单实例注入
`createAgent` SHALL 接受可选的 `sessionManager` 参数。当提供时，SHALL 使用该实例而非创建新实例。`server.ts` SHALL 创建唯一的 SessionManager 并传递给 agentFactory 和所有渠道。

#### Scenario: server.ts 启动多渠道
- **WHEN** server.ts 启动 HTTP Webhook + WebUI + TUI
- **THEN** 所有渠道和所有 AgentLoop 共享同一个 SessionManager 实例
- **AND** 不存在 `new SessionManager(cwd)` 的额外调用

## MODIFIED Requirements

### Requirement: AgentLoop.subscribeConfig
`subscribeConfig` SHALL 保留 `watch('provider.active')` 订阅，但其回调 SHALL 检查新 provider 名称是否与当前 AgentLoop 的 provider 不同，且仅在 providerRouter 中存在时才切换。这确保外部配置变更仍能生效，但内部 switchProvider 不会触发重复切换。

### Requirement: AgentLoop 构造函数 thinking 恢复
构造函数中恢复 thinking 状态的逻辑 SHALL 保留，但 SHALL 将恢复的值存储为 AgentLoop 实例字段（`thinkingEnabled`、`thinkingEffort`），而非仅设置到 provider 上。

## REMOVED Requirements

### Requirement: switchProvider 持久化全局 provider 选择
**Reason**: 全局持久化导致多 session 互相干扰，一个 session 切换 provider 会广播到所有 session。
**Migration**: 需要持久化 provider 选择的场景（如 TUI `/model` 命令）应显式调用 `configCenter.set('provider.active', name)` + `configCenter.save()`，而非依赖 switchProvider 的副作用。
