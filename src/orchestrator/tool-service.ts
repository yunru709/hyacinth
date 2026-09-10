/**
 * 工具执行服务（闭包触手正规化 · 方案 A 落点之一）。
 *
 * 旧形态：loop.ts 把三个私有方法以裸闭包注册进 stageServices——
 *   stageServices.set('executeTools', (calls) => this.executeTools(calls))
 *   stageServices.set('executeSingleInline', (id, name, input) => ...)
 *   stageServices.set('flushInline', (calls) => ...)
 * 阶段模块必须用裸字符串键 + 手写泛型才能拿到，拼错键无编译期保护，
 * 且 loop 私有方法成为阶段的事实依赖（context/llm/tools 三阶段不可替换）。
 *
 * 新形态：工具执行族收敛为一个具名服务（`toolService`），loop 装配时
 * 构造一次注册；阶段 `ctx.get<ToolService>('toolService')` 类型化消费。
 *
 * 语义保持：「每轮取当前值」——ctx 由 makeCtx 惰性构造（每轮调用现取
 * loop 的可变字段，与旧 `runToolDispatch(this.makeToolExecContext(), ...)`
 * 逐位等价）。mutable 状态（unrestricted / pendingImpact / inlineToolResults）
 * 仍经 ToolExecContext 访问器读写，不共享裸字段。
 */

import type { ToolCall } from '../types.js';
import {
  runToolDispatch,
  runToolInline,
  flushInlineResults,
  type ToolExecOutcome,
  type ToolExecContext,
} from './loop-tools.js';

/** 工具执行服务：阶段模块经 ctx.get('toolService') 消费的公开面 */
export interface ToolService {
  /** 后置执行一批工具调用（非 inline 路径：流结束后统一执行）；返回每个调用的真实结果摘要 */
  executeTools(calls: ToolCall[]): Promise<ToolExecOutcome[]>;
  /** SSE 流内执行单个工具（TOOL_USE 到达即执行，结果暂存 inlineToolResults） */
  executeSingleInline(id: string, name: string, input: Record<string, unknown>): Promise<void>;
  /** 将 inline 暂存结果回写到 conversation（assistant 消息落盘后调用保证顺序）；返回真实结果摘要 */
  flushInline(calls: ToolCall[]): Promise<ToolExecOutcome[]>;
}

/**
 * 构造工具执行服务。
 *
 * @param makeCtx 每次调用现取的工具执行上下文（loop 传入 `() => this.makeToolExecContext()`）。
 *   getter 而非快照，保证「每轮取当前值」语义与旧闭包一致。
 */
export function createToolService(makeCtx: () => ToolExecContext): ToolService {
  return {
    executeTools: (calls) => runToolDispatch(makeCtx(), calls),
    executeSingleInline: (id, name, input) => runToolInline(makeCtx(), id, name, input),
    flushInline: (calls) => flushInlineResults(makeCtx(), calls),
  };
}
