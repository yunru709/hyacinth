/**
 * 安全内核引导（bootstrap）—— 进程内 IO 边界中介的安装点。
 *
 * 安装策略（scripts/security-spike.mjs 实测结论，Node v24.11.1）：
 * - **CJS 内建对象原地变异**：`require('node:child_process')` 等返回的是进程级
 *   单例对象，变异后所有后续 require（含 node_modules 深处、node: 前缀/裸前缀）
 *   实时可见 —— 覆盖 38 处 CJS 依赖的 require('node:child_process')。
 * - **ESM 命名空间快照时序**：ESM 对内建的具名导入在链接时快照；本函数必须先于
 *   业务模块图加载（src/index.ts 静态只 import 本文件，其余走动态 import），
 *   使全部 ESM 具名导入在变异之后才创建命名空间 —— 快照到的就是守卫版。
 * - 相比 loader hooks（module.register）方案：无 loadBuiltinWithHooks 崩溃风险
 *   （Node 对 node: 前缀的 CJS require 重定向到文件会崩），无独立钩子线程。
 *
 * TCB 诚实声明：进程内变异可被同进程的原生 addon / 反变异对抗 —— 见
 * docs/security-kernel.md 的威胁模型边界；完整性由 canary（integrity.ts）核验。
 */

import { createRequire } from 'node:module';
import { createLogger } from '../../logging/logger.js';
import { resolveSecurityMode } from './config.js';
import { markInstalled, markOff, markDegraded, getSecurityStatus } from './integrity.js';
import { appendAudit } from './audit.js';
import { guardChildProcess, guardHttpModule, guardGlobalFetch, collectGuardProbes } from './guards.js';

const logger = createLogger('security-kernel');

let installed = false;

/**
 * 安装安全内核。幂等；在 src/index.ts 顶部（一切业务模块加载之前）调用。
 * security.mode=off 时保持 off（零变异，行为与旧版一致）。
 */
export function bootstrapSecurity(): void {
  if (installed) return;
  installed = true;

  const mode = resolveSecurityMode();
  if (mode === 'off') {
    markOff();
    logger.info('security kernel disabled (mode=off)');
    return;
  }

  const require = createRequire(import.meta.url);

  // 1. 进程域：child_process 全家族
  const cp = require('node:child_process') as Record<string, unknown>;
  guardChildProcess(cp);

  // 2. 网络域：http/https 出站客户端 + globalThis.fetch
  const http = require('node:http') as Record<string, unknown>;
  const https = require('node:https') as Record<string, unknown>;
  guardHttpModule(http);
  guardHttpModule(https);
  guardGlobalFetch();

  // 3. canary 自检：确认守卫真实在位（防"变异未生效"的假安装）
  const probes = collectGuardProbes(require);
  const failed = probes.filter((p) => !p.ok);
  if (failed.length > 0) {
    // 假安装比不安装更危险：如实降级（后续 LLM 归因裁决 fail-closed）
    markDegraded(`guard probes failed: ${failed.map((f) => f.name).join(', ')}`);
    logger.error(`security kernel installed but probes FAILED: ${failed.map((f) => f.name).join(', ')}`);
  } else {
    markInstalled();
    logger.info('security kernel active', { mode, probes: probes.length });
  }
  appendAudit({ type: 'kernel.bootstrap', mode, degraded: failed.length > 0 });
}

/** 完整性核验（插件 mount 后 / 关键路径前调用）；失效时降级并返回 false */
export function verifySecurityIntegrity(): boolean {
  if (getSecurityStatus() === 'off') return true;
  const require = createRequire(import.meta.url);
  const failed = collectGuardProbes(require).filter((p) => !p.ok);
  if (failed.length > 0) {
    markDegraded(`canary failed: ${failed.map((f) => f.name).join(', ')}`);
    return false;
  }
  return true;
}
