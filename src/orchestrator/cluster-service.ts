/**
 * 意图簇 + deep 压缩状态服务（闭包触手正规化 · 方案 A 落点之二）。
 *
 * 旧形态：loop.ts 把两个闭包注册进 stageServices——
 *   stageServices.set('clusterTransform', () => this.buildClusterHistoryTransform())
 *   stageServices.set('deepCompressRestore', () => this._maybeRestoreSummary())
 * 同时 `_deepCompressOriginal` / `_deepCompressRestore` / `needsCompression`
 * 三个 mutable 字段挂在 loop 上，`tools/compression.ts` 甚至用
 * `(agentLoop as any)` 直接写私有字段——工具层绕过类型检查直连内核状态。
 *
 * 新形态：
 * - 意图簇构建 + deep 模板恢复收敛为具名服务（`clusterService`）
 * - 三个 mutable 字段迁入服务内部，对外只暴露类型化 API
 *   （setDeepCompressState / getNeedsCompression / setNeedsCompression），
 *   trigger_compression 工具改走该 API，消除 `as any` 触手
 *
 * 语义保持：deps 由 makeDeps 惰性构造（每轮取当前值），与旧
 * `buildClusterHistoryTransform(this.makeClusterDeps())` 逐位等价。
 */

import type { Message } from '../types.js';
import {
  buildClusterHistoryTransform,
  maybeRestoreSummary,
  type ClusterDeps,
} from './loop-cluster.js';

/** deep 压缩临时模板状态（trigger_compression 经 setDeepCompressState 写入） */
export interface DeepCompressState {
  /** 临时替换前的原始 summary.md 内容（null = 原本无自定义模板） */
  original: string | null;
  /** 是否需要恢复（写入模板后置 true，恢复完成后自动复位） */
  restore: boolean;
}

/** 意图簇 + deep 压缩状态服务：阶段模块与工具经此消费的公开面 */
export interface ClusterService {
  /** cluster 历史过滤变换（构建失败/无簇 → null） */
  buildClusterHistoryTransform(): Promise<((msgs: Message[]) => Message[]) | null>;
  /** 消费压缩结果后恢复被临时替换的 summary.md（幂等：restore=false 时 no-op） */
  restoreSummary(): void;
  /** trigger_compression(level=deep) 写入临时模板状态 */
  setDeepCompressState(state: DeepCompressState): void;
  /** 读取当前 deep 压缩状态（诊断用） */
  getDeepCompressState(): DeepCompressState;
  /** 强制重压缩标记（provider 切换后 / trigger_compression 置位） */
  getNeedsCompression(): boolean;
  setNeedsCompression(v: boolean): void;
}

/**
 * 构造意图簇服务。
 *
 * @param makeDeps 每次调用现取的簇压缩依赖（loop 传入 `() => this.makeClusterDeps()`）。
 *   getter 而非快照，保证「每轮取当前值」语义与旧闭包一致。
 */
export function createClusterService(makeDeps: () => ClusterDeps): ClusterService {
  let deepCompressOriginal: string | null = null;
  let deepCompressRestore = false;
  let needsCompression = false;

  return {
    buildClusterHistoryTransform: () => buildClusterHistoryTransform(makeDeps()),
    restoreSummary() {
      const r = maybeRestoreSummary({
        deepCompressRestore,
        deepCompressOriginal,
      });
      deepCompressRestore = r.deepCompressRestore;
      deepCompressOriginal = r.deepCompressOriginal;
    },
    setDeepCompressState(state: DeepCompressState) {
      deepCompressOriginal = state.original;
      deepCompressRestore = state.restore;
    },
    getDeepCompressState: () => ({
      original: deepCompressOriginal,
      restore: deepCompressRestore,
    }),
    getNeedsCompression: () => needsCompression,
    setNeedsCompression: (v) => { needsCompression = v; },
  };
}
