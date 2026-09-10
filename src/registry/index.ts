// 统一 Registry 导出
export { GenericRegistry } from './base.js';
export type { RegistryItem, RegistryEvent, RegistryEventListener } from './base.js';

export { ToolRegistry } from './tool.registry.js';
export { SkillRegistry, createBuiltinSkills } from './skill.registry.js';
export { AgentRegistry } from './agent.registry.js';
// ProviderRegistry / ChannelRegistry / PluginRegistry 已废弃（2026-09，P4）——
// ProviderRouter / ModelChannelRegistry / PluginManager 已分别覆盖全部语义，无消费者。
// McpRegistry 已移除 — MCP 统一由 MCPSystem 管理，不再需要独立 Registry 包装