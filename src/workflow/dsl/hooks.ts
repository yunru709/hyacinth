/**
 * ## HookRegistry — 外部函数逃逸机制
 *
 * 项目设计原则：99% 的行为应通过声明式 DSL 表达。
 * 但有少量操作无法声明式描述（如 Bootstrap 的 validatePersonaFilesSync），
 * 这些通过 Hook 机制作为逃逸出口。
 *
 * Hook 函数签名：
 *   (state: WorkflowState, ...args: string[]) => { success: boolean; message: string }
 *
 * 新增 Hook：
 *   1. 在 JS/TS 文件中实现 HookFunction 签名的函数
 *   2. 在 factory.ts 中调用 hookRegistry.register('name', fn)
 *   3. 在 YAML 中引用：hooks.<name>: { module: "...", export: "..." }
 *
 * 错误处理约束：
 *   - Hook 调用必须 try/catch，失败不崩溃
 *   - 失败时返回 { success: false, message: error.message }
 */
import type { WorkflowState } from '../types.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('workflow:dsl:hooks');

// ─── Types ────────────────────────────────────────────────────────────────

export interface HookResult {
  success: boolean;
  message: string;
}

export type HookFunction = (
  state: WorkflowState,
  ...args: string[]
) => HookResult;

// ─── Registry ─────────────────────────────────────────────────────────────

export class HookRegistry {
  private hooks = new Map<string, HookFunction>();

  /** 注册一个钩子函数 */
  register(name: string, fn: HookFunction): void {
    this.hooks.set(name, fn);
    logger.debug(`Hook registered: ${name}`);
  }

  /** 注销钩子 */
  unregister(name: string): boolean {
    return this.hooks.delete(name);
  }

  /** 检查钩子是否存在 */
  has(name: string): boolean {
    return this.hooks.has(name);
  }

  /**
   * 调用钩子。
   * 自动 try/catch 包裹，失败返回 error result 而不抛出。
   */
  invoke(name: string, state: WorkflowState, args: string[]): HookResult {
    const fn = this.hooks.get(name);
    if (!fn) {
      logger.warn(`Hook not found: ${name}`);
      return { success: false, message: `Hook not found: ${name}` };
    }

    try {
      const result = fn(state, ...args);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Hook "${name}" threw: ${message}`);
      return { success: false, message: `Hook error: ${message}` };
    }
  }

  /** 获取所有已注册 hook 名称 */
  getNames(): string[] {
    return [...this.hooks.keys()];
  }
}

/** 全局单例 HookRegistry */
let globalHookRegistry: HookRegistry | null = null;

export function getGlobalHookRegistry(): HookRegistry {
  if (!globalHookRegistry) {
    globalHookRegistry = new HookRegistry();
  }
  return globalHookRegistry;
}

export function setGlobalHookRegistry(registry: HookRegistry): void {
  globalHookRegistry = registry;
}
