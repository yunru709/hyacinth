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

const { createLogger } = await import('./logging/logger.js');
const { runCli } = await import('./gateway/cli.js');

const logger = createLogger('app');
runCli().catch((err) => logger.error('Unhandled error', err instanceof Error ? err : undefined));
