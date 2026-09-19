/**
 * 阶段服务映射表 —— 内核服务注册表的**类型化声明**（方案 C 第二步）。
 *
 * 用途：
 * - `StageServiceKey` 从 create-kernel.ts 迁移至此（单一真源，loop/装配方共 import）
 * - `StageServiceMap` 把每个服务键映射到具体类型，`StageContext<StageServiceMap>`
 *   的 get/require 因此编译期受保护：拼错键、取错类型立即报错（审查报告 #1+#2 收口）
 *
 * 分层：本文件位于 orchestrator 层，允许引用任意业务服务类型；
 * 与 kernel/pipeline.ts 的 `StageContext<Svc>` 泛型搭配，内核本身保持零业务依赖。
 */

import type { StageContext } from '../kernel/pipeline.js';
import type { ConversationStore } from '../memory/conversation.js';
import type { EventStore } from '../memory/events.js';
import type { StatsManager } from '../memory/stats.js';
import type { SummaryStore } from '../memory/summary.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import type { ContextComposerLike } from '../context/interface.js';
import type { CompressorOrchestrator } from '../context/compressor.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { IContextRouter } from '../context/router.js';
import type { TurnRecorder } from '../rollback/turn-recorder.js';
import type { BypassManager } from '../bypass/manager.js';
import type { LoopHookBus } from './loop-hooks.js';
import type { LLMOrchestrator } from './planner.js';
import type { ToolService } from './tool-service.js';
import type { ClusterService } from './cluster-service.js';
import type { OutputHandler } from './loop.js';

/**
 * 内核服务注册表（服务键 → 类型）。
 *
 * 键集合必须与 loop.ts 构造期的 stageServices.set 全部一致；
 * 可缺失的服务用联合类型标注（get 返回 `T | undefined`），
 * 必然存在的服务不标注（require 缺失抛错）。
 *
 * 注意：toolService / clusterService 是旧「闭包触手」的正规化替身——
 * 阶段按需 get + 判空（替换模块可以不提供工具执行能力，语义与旧闭包一致）。
 */
export interface StageServiceMap {
  conversationStore: ConversationStore;
  configCenter: RuntimeConfigCenter | undefined;
  compressor: CompressorOrchestrator;
  turnRecorder: TurnRecorder | undefined;
  sessionDir: string;
  toolRegistry: ToolRegistry;
  contextComposer: ContextComposerLike;
  summaryStore: SummaryStore | undefined;
  statsManager: StatsManager;
  gitManager: GitManager;
  outputHandler: OutputHandler | null;
  maxContextTokens: number;
  personaDir: string | undefined;
  bundleRegistry: ToolBundleRegistry | undefined;
  kbState: { lastQuery: string } | null;
  loopHooks: LoopHookBus;
  getRouter: () => IContextRouter;
  eventStore: EventStore;
  orchestrator: LLMOrchestrator;
  bypassManager: () => BypassManager | undefined;
  /** 工具执行服务（executeTools / executeSingleInline / flushInline；替代旧 executeTools/flushInline/executeSingleInline 三闭包） */
  toolService: ToolService | undefined;
  /**
   * 引用分析能力（Phase 6）：由 xref 插件经 ctx.registerStageService 注册/摘除。
   * 缺省（xref 未挂载）⇒ 核心后置消费者退回内置字符串扫描兜底。
   */
  referenceAnalysis: import('../tools/reference-analysis.js').ReferenceAnalysisCapability | undefined;
  /** 意图簇 + deep 压缩状态服务（替代旧 clusterTransform/deepCompressRestore 两闭包） */
  clusterService: ClusterService | undefined;
}

/** 内核服务键（get/require 的编译期键空间） */
export type StageServiceKey = keyof StageServiceMap;

/** 内核阶段上下文（orchestrator 层专用：get/require 已类型化） */
export type KernelStageContext = StageContext<StageServiceMap>;
