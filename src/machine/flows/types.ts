// ============================================================
// Flow Types — Flow 层类型定义
// ============================================================
//
// 扩展 machine 层的通用类型，添加 Flow 特有的概念：
//   - getInjection() — Zone 5 注入文本
//   - FlowController — 统一的 Flow 接口
// ============================================================

import type { MachineContext, MachineSnapshot, AdvanceResult } from '../types.js';
import type { MachineRunner } from '../runner.js';

/**
 * FlowController — 所有 Flow 的统一接口。
 *
 * 每个 Flow 内部包装一个 MachineRunner 做状态管理，
 * 对外提供 getInjection() 给 Zone 5 上下文注入。
 */
export interface FlowController {
  /** Flow 唯一标识（与 MachineDef.id 一致） */
  readonly id: string;
  /** 内部状态机 */
  readonly runner: MachineRunner;

  /** 激活 Flow */
  activate(context?: MachineContext): void;
  /** 停用 Flow */
  deactivate(): void;
  /** 通过事件推进状态机（委托给 runner.advance） */
  advance(event: string): AdvanceResult;
  /** 结构化快照（委托给 runner.getSnapshot） */
  getSnapshot(): MachineSnapshot;
  /** Zone 5 注入文本（当前步骤的提示词） */
  getInjection(): string | null;
  /** 是否已完成 */
  isComplete(): boolean;
  /** 向 Flow 添加定义项（仅 definition 阶段有效，非转移操作）。
   *  TODO 模式加执行步骤，plan 模式加计划章节，spec 模式不需要。 */
  addItem?(description: string): { id: string; label: string };
}
