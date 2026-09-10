/**
 * 安全内核公共出口。
 *
 * 分层约束（scripts/verify-layers.mjs 规则 1）：本目录只允许依赖
 * `../logging/` 与目录内兄弟模块 + node 内建 —— 不引入任何业务依赖。
 *
 * 业务侧消费方式（business → kernel 方向，符合依赖方向）：
 *   import { bootstrapSecurity, runAttributed } from '../kernel/security/index.js';
 */

export { bootstrapSecurity, verifySecurityIntegrity } from './bootstrap.js';
export { getSecurityStatus, getDegradedReason } from './integrity.js';
export { runAttributed, currentAttribution } from './attribution.js';
export { registerSecretKeys, scrubEnv, isSecretKeyName } from './env-guard.js';
export { classifyCommand, checkProcess, checkNetwork, isPrivateHost, currentMode } from './policy.js';
export { isGuarded, GUARD_MARK } from './guards.js';
export { injectSecurityConfigReader, getSecurityConfig, resolveSecurityMode } from './config.js';
export { appendAudit, getAuditFile, setAuditFile } from './audit.js';
export type { SecurityMode, KernelStatus, ToolAttribution, CommandVerdict, ProcessDecision, AuditEvent } from './types.js';
