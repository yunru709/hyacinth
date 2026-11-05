#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════
 *  模块地图 / 治理层索引 ——「重新认路」前先读这段，别靠翻文档。
 *  分层（依赖只允许由外指向内；7 条硬规则由 scripts/verify-layers.mjs 机器校验）：
 *   ① 内核 kernel/        hook-bus · pipeline · plugin-host · security/（零业务依赖 = 规则1）
 *   ② 核心 orchestrator/  loop + 6 stages + 规划/目标/权限/工具服务/集群；
 *                         context/ · memory/ · tools/(103 工具) · provider/(厂商+路由+降级) · prompts/
 *   ③ 适配 channels/ · ui-protocol/ · ui/ · webui/   （业务核心不得反向依赖 = 规则2/5）
 *   ④ 装配 gateway/       boot · agent-assembly · *-contributions · *-wiring · factory(薄壳) · cli · server
 *  横切/治理层（演化长出来的，会咬人；按用途认领，别混进主干）：
 *   bypass/(⚠️旁路智能体元认知层,直注主上下文,改前读模块头) · world-engine/(⚠️旁路世界模型)
 *   supervisor/(进程级监督+出厂架构只读视图) · lifecycle/(生命周期) · machine/(通用状态机)
 *   registry/(统一 Registry 基类) · repair/(LoopGuard 防重复) · rollback/(回合回滚)
 *   evolution/(Git+自动提交) · dependency/(源码依赖/数据流分析)
 *  扩展/能力面：plugins/ · skills/ · generation/ · stt/ · tts/ · media/ · multimodal/ · knowledge/ · local-model/
 *  读码捷径：入口 bootstrap.ts(指针壳) → index.ts(本文件,安全先行)；改装配看 gateway/agent-assembly.ts；
 *           改一轮 turn 看 orchestrator/stages/{input,bypass,context,llm,tools,finalize}.ts
 * ════════════════════════════════════════════════════════════════
 */
import { bootstrapSecurity } from './kernel/security/index.js';

// 安全内核必须先于一切业务模块安装：index.ts 只静态 import 内核，
// 其余全部走动态 import —— 保证 ESM 对内建模块的具名导入在守卫变异
// 之后才创建命名空间（scripts/security-spike.mjs 实测结论）。
bootstrapSecurity();

// ── 守护进程分流（必须在加载 cli.js **之前**）──────────────────────────
// 为什么在这里：guardian 父进程的职责只有「spawn 子进程 + 守候退出码」，
// 完全不需要 CLI 依赖链（commander / 全量命令定义 / provider 装配）。
// 历史上该判断埋在 cli.ts runCli() 的 program.parse() 之前（~L1357）——
// 那时 cli.js 及其整条 import 图已加载完 ⇒ 每个后端白白多背一份「半个 CLI」
// （实测本机父进程 17008 私有内存 74.7 MB，子进程 320 MB；父子 argv 逐字相同
//  就是本机制造成的，曾被误判成「两个后端抢端口」）。
// 挪到 index.ts 后，guardian 侧只加载 supervisor/protocol + supervisor/guardian。
// ⚠️ 与 cli.ts 内保留的同名兜底判断**条件必须一致**（--no-guardian / GUARDIAN_ENV）：
//    cli.ts 那份用于「绕过 index.ts 直接调 runCli()」的场景，勿删勿改条件。
const { GUARDIAN_ENV } = await import('./supervisor/protocol.js');
const noGuardian = process.argv.includes('--no-guardian');

if (!noGuardian && !process.env[GUARDIAN_ENV]) {
  const { runGuardian } = await import('./supervisor/guardian.js');
  runGuardian(process.argv.slice(2));
} else {
  const { createLogger } = await import('./logging/logger.js');
  const { runCli } = await import('./gateway/cli.js');
  const logger = createLogger('app');
  runCli().catch((err) => logger.error('Unhandled error', err instanceof Error ? err : undefined));
}
