// ============================================================
// provider/user-id — 集中管理 DeepSeek KVCache 隔离 ID
// ============================================================
//
// DeepSeek API 通过 user_id 字段隔离不同调用方的 KV 缓存池。
// 不同角色/模式应使用不同的 userId，避免缓存互相污染。
//
// 命名规范：
//   {prefix}-{role}              静态角色（旁路、压缩器等单实例）
//   {prefix}-{role}-{tag}        动态角色（主Agent、子Agent 等多实例）
//
// 前缀默认 'hyacinth'，可通过 setUserIdPrefix() 在启动时覆盖
//（同步 config.provider.userId）。
//
// 6 个 LLM 调用点：
//   1. 主Agent（普通模式） → {prefix}-main-{sessionTag}
//   2. 旁路Agent（普通模式） → {prefix}-orchestrator
//   3. 主Agent（陪伴模式） → {prefix}-companion-{characterName}
//   4. 旁路Agent（陪伴模式） → {prefix}-narration
//   5. 压缩器               → {prefix}-compressor
//   6. 子Agent              → {prefix}-sub-{name}-{instanceId}
// ============================================================

// ── 默认（唯一硬编码兜底值） ─────────────────────────────────

export const DEFAULT_USER_ID = 'hyacinth';

let _prefix: string = DEFAULT_USER_ID;

// ── 前缀管理 ────────────────────────────────────────────────

/** 启动时调用，将前缀同步为配置中的 provider.userId */
export function setUserIdPrefix(prefix: string): void {
  _prefix = prefix;
}

function make(role: string, tag?: string): string {
  return tag ? `${_prefix}-${role}-${tag}` : `${_prefix}-${role}`;
}

// ── 主Agent ──────────────────────────────────────────────────

/** 主Agent 普通模式 */
export function mainUserId(sessionTag: string): string {
  return make('main', sessionTag);
}

/** 主Agent 陪伴模式 */
export function companionUserId(characterName: string): string {
  return make('companion', characterName);
}

// ── 旁路Agent ───────────────────────────────────────────────

// 旁路双模式各自独立实例（userId 跟随通道）；session 粒度待 base 调用链
// 携带 sessionId 后升级（签名已按 make 预留）
export function orchestratorUserId(sessionTag?: string): string {
  return sessionTag ? make('orchestrator', sessionTag) : make('orchestrator');
}
export function narrationUserId(sessionTag?: string): string {
  return sessionTag ? make('narration', sessionTag) : make('narration');
}

// ── 压缩器 ──────────────────────────────────────────────────

/**
 * 压缩器。传入 sessionTag（如 session 目录名）时按 session 隔离 KVCache——
 * 压缩请求含用户对话内容，内容安全/KVCache 均按 user_id 聚合，session 粒度隔离
 * 依赖 ModelRouter.createScopedProvider 按次现建实例（长驻共享实例无法按 session 切换）。
 */
export function compressorUserId(sessionTag?: string): string {
  return sessionTag ? make('compressor', sessionTag) : make('compressor');
}

// ── 子Agent ─────────────────────────────────────────────────

/** 子Agent（按名称 + 实例ID 隔离） */
export function subAgentUserId(agentName: string, instanceId: string): string {
  return make('sub', `${agentName}-${instanceId}`);
}
