# Checklist

- [x] `switchProvider` 中不再调用 `configCenter.set('provider.active', ...)` 和 `configCenter.save()`
- [x] `subscribeConfig` 中的 `watch('provider.active')` 回调有守卫，不会因内部 switchProvider 触发重复切换
- [x] TUI `/model` 命令如需持久化 provider，已显式调用 `configCenter.set` + `save`
- [x] AgentLoop 拥有 `thinkingEnabled` 和 `thinkingEffort` 实例字段
- [x] 构造函数恢复 thinking 时同时设置实例字段
- [x] `watch('provider.enableThinking')` 回调更新实例字段
- [x] `provider.createStream()` 调用前应用了当前 AgentLoop 的 thinking 状态
- [x] `CreateAgentOptions` 接受可选的 `sessionManager` 参数
- [x] `createAgent` 优先使用注入的 SessionManager
- [x] `server.ts` 只创建一个 `new SessionManager(cwd)` 并注入到 agentFactory
- [x] `webui-ws-session.ts` 不再 `new SessionManager`，使用注入的实例
- [x] 根项目 TypeScript 检查通过
- [x] WebUI TypeScript 检查通过
