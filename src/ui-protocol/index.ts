// ============================================================
// UI 协议层 — 统一入口
// ============================================================
// 单一装配器（P5 收敛）：channels/builtin/ui-protocol-session.ts 的
// `UiProtocolSession` 是唯一生产装配入口——构造注册静态域（config/
// session/model/command/permission/kb/process/orchestrator/
// context/tool/bundle/mcp/companion），initialize(agentFactory) 拿到
// AgentLoop 后注册动态域（message/state/schedule）并 attach 传输适配器。
//
// 历史：`createProtocolServer` 曾作为备选装配器（无生产调用者），
// P5-1 已删除，其测试迁移至 UiProtocolSession。本文件保留：
//   - UiProtocolServer / 传输适配器 / 协议类型 / 全部域工厂的再导出
// ============================================================

import { UiProtocolServer } from './server.js';
import { createConfigDomain } from './domains/config.js';
import { createSessionDomain } from './domains/session.js';
import { createModelDomain } from './domains/model.js';
import { createMessageDomain, ProtocolOutputHandler } from './domains/message.js';
import { createStateDomain } from './domains/state.js';
import { createPermissionDomain, PendingRequestRegistry } from './domains/permission.js';
import { createCommandDomain } from './domains/command.js';
import { createKbDomain } from './domains/kb.js';
import { createProcessDomain } from './domains/process.js';
import { createOrchestratorDomain } from './domains/orchestrator.js';
import { createScheduleDomain } from './domains/schedule.js';
import { createContextDomain } from './domains/context.js';
import { createToolDomain } from './domains/tool.js';
import { createBundleDomain } from './domains/bundle.js';
import { createMCPDomain } from './domains/mcp.js';
import { createPluginDomain } from './domains/plugin.js';
import { createCompanionDomain } from './domains/companion.js';

// ────────────────────────────────────────────────────────────
// 再导出（供外部集成与扩展）
// ────────────────────────────────────────────────────────────

// 服务器核心
export { UiProtocolServer } from './server.js';
export type { DomainAction, DomainHandler, RequestContext } from './server.js';

// 传输适配器
export { InProcAdapter, createInProcPair } from './adapter.js';
export type { UIAdapter } from './adapter.js';
export { WsAdapter, attachWsUpgrade } from './transport/ws.js';
export type { WsAdapterOptions, AttachWsOptions } from './transport/ws.js';

// 协议类型
export * from './types.js';

// 全部 17 个域工厂 + 类型（协议层统一出口）
export { createConfigDomain } from './domains/config.js';
export type { ConfigCenterLike, ConfigDomain, ConfigDomainOptions } from './domains/config.js';
export { createSessionDomain } from './domains/session.js';
export type { SessionManagerLike, SessionDomainOptions, BackendSession } from './domains/session.js';
export { createModelDomain } from './domains/model.js';
export type {
  ModelRegistryLike,
  ProviderManagerLike,
  ProviderMetaLike,
  ModelDomainOptions,
  ChannelConfigLike,
  ChannelInfoLike,
  ProviderView,
} from './domains/model.js';
export { createMessageDomain, ProtocolOutputHandler } from './domains/message.js';
export type { MessageDomainOptions } from './domains/message.js';
export { createStateDomain, buildStateSnapshot, calcContextUsagePct } from './domains/state.js';
export type {
  LoopLike,
  TurnInfoLike,
  RoutingInfoLike,
  ActiveProviderLike,
  StateDomainOptions,
} from './domains/state.js';
export { createPermissionDomain, PendingRequestRegistry } from './domains/permission.js';
export type { PermissionDomainOptions } from './domains/permission.js';
export { createKbDomain } from './domains/kb.js';
export type { KnowledgeBaseLike, KbDomainOptions } from './domains/kb.js';
export { createProcessDomain } from './domains/process.js';
export type { BackgroundRegistryLike, ProcessDomainOptions } from './domains/process.js';
export { createOrchestratorDomain } from './domains/orchestrator.js';
export type { BypassManagerLike, OrchestratorDomainOptions } from './domains/orchestrator.js';
export { createScheduleDomain } from './domains/schedule.js';
export type { SchedulerLike, SchedulerStatusLike, ScheduleDomainOptions } from './domains/schedule.js';
export { createContextDomain } from './domains/context.js';
export { createToolDomain } from './domains/tool.js';
export type { ToolRegistryLike, ToolDomainOptions } from './domains/tool.js';
export { createBundleDomain } from './domains/bundle.js';
export type { BundleRegistryLike, BundleDomainOptions } from './domains/bundle.js';
export { createMCPDomain } from './domains/mcp.js';
export type { MCPSystemLike, MCPDomainOptions } from './domains/mcp.js';
export { createCompanionDomain } from './domains/companion.js';
export type {
  CompanionMgrLike,
  RouterSwitcherLike,
  CompanionLoopLike,
  VoiceEntryLike,
  VoiceLibraryLike,
  GeneratedVoiceRowLike,
  VoiceGenStoreLike,
  SayHistoryEntryLike,
  SayHistoryStoreLike,
  CompanionDomainOptions,
} from './domains/companion.js';
export { createCommandDomain } from './domains/command.js';
export type {
  CommandRegistryLike,
  CommandDefLike,
  CommandExecutor,
  CommandDomainOptions,
} from './domains/command.js';
