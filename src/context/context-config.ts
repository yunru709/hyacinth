import type { RuntimeConfigCenter } from '../runtime/config-center.js';

/**
 * 上下文配置出口 — 压缩器与 zone 预算的默认参数统一走 configCenter（context.* 键）。
 *
 * 模式与 tools/tool-config.ts、provider/local-config.ts 一致：factory.ts 初始化
 * configCenter 后注入；注入前（bootstrap / 单测）回退硬编码默认值，零行为变化。
 *
 * 键位约定（schema/defaults 同步登记；未注明的为既有键，本模块负责接活）：
 *   context.safetyThreshold        压缩安全阈值（默认 0.95，原 CompressorOrchestrator 硬编码）
 *   context.targetRatio            理想压缩目标比率（默认 0.15，原硬编码）
 *   context.clusterBudgetRatio     分簇预算占 historyBudget 比例（默认 0.7，原硬编码）
 *   context.zone5TailBudgetRatio   Zone5 尾部保护预算（默认 0.15，原 stages/context 硬编码）
 *   context.scratchpadMaxChars     临时记事本（Zone 5）注入上限，默认 8000 字符
 *   context.zone4BudgetRatio       Zone4 检索预算（默认 0.5，原 section-resolver 硬编码）
 *   context.maxCompressRounds      最大压缩轮数（schema/defaults 已有，原 CompressorOrchestrator 硬编码 3，此前零消费）
 *   context.trimWindow             工具结果保护窗口（schema/defaults 已有，原 CompressorOrchestrator 硬编码 6，此前零消费）
 */

let _configCenter: RuntimeConfigCenter | null = null;

/** 注入 RuntimeConfigCenter（factory.ts 初始化后调用）；传 null 还原（测试用） */
export function injectContextConfigCenter(cc: RuntimeConfigCenter | null): void {
  _configCenter = cc;
}

/** 读取 context 配置键，未注入/未配置/异常一律回退 fallback */
export function getContextConfig<T>(key: string, fallback: T): T {
  if (!_configCenter) return fallback;
  try {
    const v = _configCenter.get<T>(`context.${key}`);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// ── 便捷读取（各消费点专用）───────────────────────────────────────────

export function safetyThreshold(): number {
  return getContextConfig<number>('safetyThreshold', 0.95);
}

export function targetRatio(): number {
  return getContextConfig<number>('targetRatio', 0.15);
}

/** 分簇预算占 historyBudget 的比例（决策 H：留 30% 给其他 zone） */
export function clusterBudgetRatio(): number {
  return getContextConfig<number>('clusterBudgetRatio', 0.7);
}

/**
 * 临时记事本（Zone 5）注入上限（字符）—— 超出截断并在注入文本里标注。
 * 与 zone5TailBudgetRatio 同法：模块级读取，调用方不必多传依赖 ✓
 */
export function scratchpadMaxChars(): number {
  return getContextConfig<number>('scratchpadMaxChars', 8000);
}

export function zone5TailBudgetRatio(): number {
  return getContextConfig<number>('zone5TailBudgetRatio', 0.15);
}

export function zone4BudgetRatio(): number {
  return getContextConfig<number>('zone4BudgetRatio', 0.5);
}

export function maxCompressRounds(): number {
  return getContextConfig<number>('maxCompressRounds', 3);
}

export function trimWindow(): number {
  return getContextConfig<number>('trimWindow', 6);
}

/** 全量存档召回（pool_context）启用阈值：工作历史达到该条数才读存档做关键词召回 */
export function poolMinHistory(): number {
  return getContextConfig<number>('poolMinHistory', 200);
}
