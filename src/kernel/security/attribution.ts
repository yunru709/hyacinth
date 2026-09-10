/**
 * 归因（Attribution）—— AsyncLocalStorage 标记"本次 IO 由谁驱动"。
 *
 * 参照 dsh 的 per-call policy：内核裁决按归因分档——
 *   LLM 工具执行期的 spawn/fetch 受最严策略；框架自身调用（provider、
 *   本地模型健康检查、渠道客户端）只做 env 守卫，不受私网拦截。
 *
 * 包裹点（全库仅两处执行入口 + 一处调度）：
 *   tools/executor.ts execute()          —— 批量路径
 *   orchestrator/loop-tools.ts inline    —— SSE 流内路径
 *   gateway/runtime-wiring.ts 定时任务   —— schedule 归因
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolAttribution } from './types.js';

const storage = new AsyncLocalStorage<ToolAttribution>();

/** 在归因上下文中执行异步函数 */
export function runAttributed<T>(attr: ToolAttribution, fn: () => Promise<T>): Promise<T> {
  return storage.run(attr, fn);
}

/** 读当前归因（无则说明是框架自身调用） */
export function currentAttribution(): ToolAttribution | undefined {
  return storage.getStore();
}
