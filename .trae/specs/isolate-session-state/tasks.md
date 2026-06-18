# Tasks

- [x] Task 1: 移除 switchProvider 的全局广播
  - [x] SubTask 1.1: 在 `loop.ts` 的 `switchProvider` 方法中，删除 `configCenter.set('provider.active', providerName)` 和 `configCenter.save()` 调用
  - [x] SubTask 1.2: 确认 `subscribeConfig` 中的 `watch('provider.active')` 回调仍保留，但添加守卫：仅当新 provider 名称与当前不同且 providerRouter 中存在时才切换
  - [x] SubTask 1.3: 检查 TUI `/model` 命令路径，如需持久化 provider 选择，在 TUI 侧显式调用 `configCenter.set` + `save`

- [x] Task 2: Per-turn thinking 状态应用
  - [x] SubTask 2.1: 在 AgentLoop 中添加 `thinkingEnabled: boolean` 和 `thinkingEffort: string | number | undefined` 实例字段
  - [x] SubTask 2.2: 构造函数中恢复 thinking 时，同时设置实例字段和 provider
  - [x] SubTask 2.3: 在 `watch('provider.enableThinking')` 回调中，更新实例字段（而非直接调 provider.setThinking）
  - [x] SubTask 2.4: 在 AgentLoop 调用 `provider.createStream()` 之前（即 runTurn 中实际发起 LLM 请求的位置），调用 `this.getActiveProvider().setThinking(this.thinkingEnabled, this.thinkingEffort)` 确保当前 provider 状态正确

- [x] Task 3: SessionManager 单实例注入
  - [x] SubTask 3.1: 在 `CreateAgentOptions` 接口中添加可选的 `sessionManager?: SessionManager` 参数
  - [x] SubTask 3.2: 在 `createAgent` 中，当 `options.sessionManager` 提供时使用它，否则 fallback 到 `new SessionManager(cwd)`（保持向后兼容）
  - [x] SubTask 3.3: 在 `server.ts` 的 `agentFactory.createAgent` 中，将已创建的 `sessionManager` 传入 `createAgent`
  - [x] SubTask 3.4: 在 `webui-ws-session.ts` 的 `handleSetMode` 和 `getSessionForMode` 中，使用从 channel 注入的 SessionManager 而非 `new SessionManager(cwd)`
  - [x] SubTask 3.5: 在 `WebUIChannel.start` 中保存 `sessionManager` 引用，并传递给 `WebUIWsSession`

- [x] Task 4: 验证与类型检查
  - [x] SubTask 4.1: 运行根项目 `tsc --noEmit` 确认无类型错误
  - [x] SubTask 4.2: 运行 WebUI `tsc --noEmit` 确认无类型错误
  - [x] SubTask 4.3: 代码审查确认 switchProvider 不再写 configCenter
  - [x] SubTask 4.4: 代码审查确认 thinking 状态在 createStream 前被应用
  - [x] SubTask 4.5: 代码审查确认 server.ts 中只有一个 `new SessionManager`

# Task Dependencies
- Task 2 独立于 Task 1，可并行
- Task 3 独立于 Task 1 和 2，可并行
- Task 4 依赖 Task 1、2、3 全部完成
