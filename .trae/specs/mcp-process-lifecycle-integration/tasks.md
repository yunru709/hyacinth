# Tasks

## Task 1: 实现 MCP 自定义 Process Transport
**Description**: 创建 `src/mcp/process-transport.ts`，实现基于 `ProcessManager` 子进程的 MCP Transport，替代 `StdioClientTransport` 的内部 spawn 行为。

- [x] SubTask 1.1: 调研 `@modelcontextprotocol/sdk` 的 `Transport` 接口定义（字段与方法）
- [x] SubTask 1.2: 实现 `ProcessTransport` 类，接收 `ChildProcess`，实现 `start()`/`send()`/`close()` 及事件回调（`onmessage`/`onclose`/`onerror`）
- [x] SubTask 1.3: 确保 JSON-RPC message 的按行读写（`\n` 分隔）与 `StdioClientTransport` 行为一致
- [x] SubTask 1.4: 验证类型编译通过

## Task 2: 改造 MCPServerManager 使用 ProcessManager 托管
**Description**: 改造 `src/mcp/lifecycle.ts`，让 `MCPServerManager` 真正通过 `ProcessManager` spawn 和停止 MCP 子进程。

- [x] SubTask 2.1: `connect()` 中调用 `this.processManager.start()` 真正 spawn 进程，获取 `ChildProcess`
- [x] SubTask 2.2: 使用 Task 1 的 `ProcessTransport` 替代 `StdioClientTransport` 与 `MCPClient` 通信
- [x] SubTask 2.3: `disconnect()` 中调用 `this.processManager.stop()` 优雅停止进程
- [x] SubTask 2.4: `reconnect()` 中复用 `ProcessManager.restart()` 逻辑
- [x] SubTask 2.5: 移除 `StdioClientTransport` 的使用（保留 SDK 其他部分）
- [x] SubTask 2.6: 验证类型编译通过

## Task 3: 改造 factory.ts 注册 MCP 到 LifecycleSupervisor
**Description**: 改造 `src/gateway/factory.ts`，让 `createAgent` 接收 `LifecycleSupervisor` 参数并注册 MCP 服务器。

- [x] SubTask 3.1: `createAgent` 签名增加 `supervisor?: LifecycleSupervisor` 参数
- [x] SubTask 3.2: 每个 `MCPServerManager` 连接成功后，调用 `supervisor?.registerMCPServer(manager.getProcessManager())`
- [x] SubTask 3.3: 确保 `LifecycleSupervisor` 被正确导入
- [x] SubTask 3.4: 验证类型编译通过

## Task 4: 改造 cli.ts 传递 supervisor
**Description**: 改造 `src/gateway/cli.ts`，在创建 Agent 时传入 `supervisor`。

- [x] SubTask 4.1: 在 `executeAction()` 中调用 `createAgent(options, supervisor)`
- [x] SubTask 4.2: 确保 `supervisor.shutdownAll()` 在 `finally` 块中无需额外改动（因为 MCP 已注册到 supervisor）
- [x] SubTask 4.3: 验证类型编译通过

## Task 5: 编译验证与端到端检查
**Description**: 确保整个改造后项目能编译，且 MCP 生命周期链路正确。

- [x] SubTask 5.1: 运行 `tsc --noEmit` 检查全项目类型
- [x] SubTask 5.2: 检查 `LifecycleSupervisor` 的 `registerMCPServer` 方法是否正确支持新注册的 MCP ProcessManager（确认接口兼容）
- [x] SubTask 5.3: 确认 `MCPServerManager.getProcessManager()` 返回的 `ProcessManager` 状态与 `LifecycleSupervisor` 兼容

# Task Dependencies
- Task 2 依赖 Task 1（需要 ProcessTransport 实现）
- Task 3 依赖 Task 2（需要 MCPServerManager 提供正确的 ProcessManager）
- Task 4 依赖 Task 3（需要 factory.ts 签名变更）
- Task 5 依赖 Task 1-4
