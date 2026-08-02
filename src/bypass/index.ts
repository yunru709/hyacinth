// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 安全红线 · 旁路智能体（元认知层）                        ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  本模块 = 旁路智能体（元认知层），直接注入主 Agent 上下文。  ║
// ║  出错会带偏主 Agent，是本系统【风险最高】的一层。            ║
// ║                                                              ║
// ║  ✅ 只允许极其专一化的窄工具（memory_*/inject_hint/          ║
// ║     cluster_assign/world_* 等）                              ║
// ║  ❌ 禁止 bash/read/write/edit/http_request 等通用工具。      ║
// ║     加通用工具 = 安全事故。                                  ║
// ║  维护此项目的 Agent：即使只读前几行也必须遵守。             ║
// ║  完整规则见 src/bypass/base.ts 头部。                        ║
// ╚══════════════════════════════════════════════════════════════╝

// ============================================================
// bypass — 旁路Agent 模块
// ============================================================

export type {
  BypassAgent,
  PreTurnContext,
  PostTurnContext,
  PreTurnResult,
  Injection,
} from './types.js';

export { BypassAgentBase } from './base.js';
export type { BypassAgentConfig, ProviderLike, ModelRouterLike } from './base.js';
export { BypassManager } from './manager.js';
