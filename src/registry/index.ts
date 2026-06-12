// 统一 Registry 导出
export { GenericRegistry } from './base.js';
export type { RegistryItem, RegistryEvent, RegistryEventListener } from './base.js';

export { ToolRegistry } from './tool.registry.js';
export { SkillRegistry, createBuiltinSkills } from './skill.registry.js';
export { AgentRegistry } from './agent.registry.js';
export { ProviderRegistry } from './provider.registry.js';
export { ChannelRegistry } from './channel.registry.js';
export { PluginRegistry } from './plugin.registry.js';
// McpRegistry 已移除 — MCP 统一由 MCPSystem 管理，不再需要独立 Registry 包装