/**
 * Tool 接口定义
 * 所有内置工具和自定义工具都必须实现此接口
 */
import type { SideEffect } from './side-effect.js';

export interface Tool {
  /** 工具名称，全局唯一标识 */
  name: string;
  /** 工具描述，供 LLM 理解工具用途 */
  description: string;
  /** 陪伴模式下的工具描述（可选）。未提供时沿用 description。
   *  用于将工具调用包装为自然行为（如「向朋友道别」而非「退出陪伴模式」）。 */
  companionDescription?: string;
  /** 陪伴模式专属（可选）。true 时普通模式的工具定义列表里完全不出现，
   *  是硬隔离而不仅是描述替换。 */
  companionOnly?: boolean;
  /** 输入参数的 JSON Schema 定义 */
  inputSchema: Record<string, unknown>;
  /** 执行工具，返回结果文本。signal 可用于中断长时间运行的工具 */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  /**
   * 执行模式：
   * - 'sync'（默认）: 阻塞等待工具完成，结果返回后继续
   * - 'asyncable': 工具支持异步执行（通过 input 中的 async 参数控制），
   *   异步模式下立即返回 handle，不阻塞后续工具和 LLM 轮次
   */
  executionMode?: 'sync' | 'asyncable';
  /**
   * 注入后台进程注册表（仅 asyncable 工具需要）。
   * 由 factory 在组装阶段调用，工具实现方负责类型转换。
   */
  setBackgroundRegistry?(registry: unknown): void;
  /**
   * 副作用等级：工具对系统外部状态的改变程度。
   * - 'read'（默认）: 只读，不改变任何状态，自动放行
   * - 'write': 修改工作区/文件系统（审批/回滚/路径围栏生效）
   * - 'exec': 执行命令/代码/网络，副作用不可逆或不可知（审批 + 命令记录）
   * 未声明时按 LEGACY_SIDE_EFFECT 按名兜底，仍未命中按 'read'。
   * 声明后四张名单（审批/回滚/LoopGuard/path-sandbox）收敛为读本字段。
   */
  sideEffect?: SideEffect;
  /**
   * 是否可与其他工具并行执行（默认 false，保守）。
   * 只读工具（read/grep/glob/ls/find）声明 true 后可并行；
   * 写/执行工具必须保持 false（串行 + 互斥），避免同文件写覆盖。
   */
  parallelSafe?: boolean;
}
