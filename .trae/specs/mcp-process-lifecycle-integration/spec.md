# MCP 进程生命周期托管集成 Spec

## Why

当前 MCP 服务器由 `@modelcontextprotocol/sdk` 内部 `StdioClientTransport` 自行 spawn，主进程无法感知子进程 PID，导致：
1. 主进程 `SIGINT`/`SIGTERM`/`exit` 时 MCP 子进程成为孤儿进程
2. `LifecycleSupervisor` 不感知 MCP 服务器，无法统一监管
3. `ProcessManager` 的崩溃恢复、健康检查、进程树清理能力完全未用于 MCP

本地模型（llama-server）已演示了正确做法：由 `ProcessManager` spawn 进程，注册到 `LifecycleSupervisor`，信号触发时统一停止。MCP 需要接入同一套基础设施。

## What Changes

- **新增** `src/mcp/process-transport.ts`：基于 `ProcessManager` 子进程的自定义 MCP Transport，替代 `StdioClientTransport`
- **改造** `src/mcp/client.ts`：`MCPClient` 支持传入外部 transport（已有 `connect(transport)` 接口，无需修改构造函数签名）
- **改造** `src/mcp/lifecycle.ts`：`MCPServerManager.connect()` 使用 `ProcessManager.start()` 真正 spawn 进程，然后通过自定义 transport 连接
- **改造** `src/mcp/lifecycle.ts`：`MCPServerManager.disconnect()` 调用 `ProcessManager.stop()` 优雅停止进程
- **改造** `src/gateway/factory.ts`：`createAgent` 接收 `supervisor?: LifecycleSupervisor` 参数，每个 `MCPServerManager` 连接成功后注册到 supervisor
- **改造** `src/gateway/factory.ts`：`AgentComponents` 返回类型不再单独暴露 `mcpManagers`，由 supervisor 统一托管
- **改造** `src/gateway/cli.ts`：把 `supervisor` 传给 `createAgent()`

## Impact

- Affected specs: 进程生命周期管理、MCP 集成、CLI 启动流程
- Affected code:
  - `src/mcp/process-transport.ts` (新增)
  - `src/mcp/client.ts` (适配)
  - `src/mcp/lifecycle.ts` (核心改造)
  - `src/gateway/factory.ts` (注册逻辑)
  - `src/gateway/cli.ts` (参数传递)

## ADDED Requirements

### Requirement: MCP 进程由 ProcessManager 托管

The system SHALL 让 `MCPServerManager` 使用 `ProcessManager` 来 spawn MCP 服务器子进程，而非让 `@modelcontextprotocol/sdk` 内部自行 spawn。

#### Scenario: 启动 MCP 服务器
- **GIVEN** 配置中存在有效的 MCP 服务器条目
- **WHEN** `MCPServerManager.connect()` 被调用
- **THEN** `ProcessManager.start()` 被调用，spawn 子进程
- **AND** 子进程通过自定义 Transport 与 `MCPClient` 建立通信
- **AND** `client.initialize()` 成功后返回 `true`

#### Scenario: 停止 MCP 服务器
- **GIVEN** MCP 服务器正在运行
- **WHEN** `MCPServerManager.disconnect()` 被调用
- **THEN** `ProcessManager.stop()` 被调用
- **AND** 子进程收到 SIGTERM，超时后被强制清理（含进程树）

### Requirement: MCP 服务器注册到 LifecycleSupervisor

The system SHALL 在主进程启动时将所有 MCP 服务器注册到 `LifecycleSupervisor`，使其参与统一的生命周期管理。

#### Scenario: 主进程退出
- **GIVEN** 多个 MCP 服务器正在运行
- **WHEN** 主进程收到 `SIGINT` 或调用 `supervisor.shutdownAll()`
- **THEN** 所有 MCP 服务器进程被优雅停止
- **AND** 若优雅停止超时，进程树被强制清理

## MODIFIED Requirements

### Requirement: MCPClient 连接方式

`MCPClient` 原有的 `connect()` 方法已经接受外部 transport 参数，无需修改签名。需要确保自定义 transport 实现兼容 MCP SDK 的 `Transport` 接口（`start()`, `send()`, `close()`, `onmessage`, `onclose`, `onerror`）。

### Requirement: factory.ts createAgent 签名

```typescript
// 改造前
export async function createAgent(options: CreateAgentOptions): Promise<AgentComponents>

// 改造后
export async function createAgent(
  options: CreateAgentOptions,
  supervisor?: LifecycleSupervisor,
): Promise<AgentComponents>
```

`LifecycleSupervisor` 从 `src/lifecycle/supervisor.js` 导入。

## REMOVED Requirements

无移除需求。保留 `StdioClientTransport` 的引用仅作为类型参考，实际连接中不再使用它 spawn 进程。
