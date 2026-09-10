/**
 * 内核基础类型 —— 生命周期与可释放资源。
 *
 * 设计依据（重构方案 §2.2）：
 * - 对齐 DSH 的 `ctx.effect` 语义与 VSCode 的 dispose pattern：
 *   **注册即返回 disposer**，卸载时逆序释放，插件无需自己记账。
 * - 相比现有 `plugins/manager.ts` 的"集中追踪表"，disposer 集合更内聚：
 *   每个插件持有自己的 DisposableStore，卸载 = store.dispose()，
 *   天然的"卸载后功能消失"验收条件（方案 §五.4）。
 */

/** 可释放资源的最小单元 */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** 释放函数（比 Disposable 更轻量的形式） */
export type Disposer = () => void | Promise<void>;

/** 把释放函数包成 Disposable */
export function toDisposable(fn: Disposer): Disposable {
  return { dispose: fn };
}

/** 空 disposer —— 用于"注册即完成、无需回滚"的场景，保证 API 形状统一 */
export function noopDisposable(): Disposable {
  return { dispose: () => {} };
}

/**
 * Disposable 集合 —— 插件/模块的生命周期账本。
 *
 * 语义：
 * - `add()` 登记资源并原样返回（便于 `const d = store.add(registerX())`）
 * - `dispose()` **逆序**释放（后注册的先释放，符合依赖顺序），异常隔离：
 *   单个资源释放失败不阻断其余资源，全部跑完后抛出**最先遇到的**那个错误。
 *   注意：由于是逆序释放，"最先遇到"= 注册顺序上最后登记的那个。
 * - `dispose()` 幂等：重复调用安全（第二次直接返回）
 */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  /** 登记一个资源；已释放的 store 会立即释放新加入的资源，防止泄漏 */
  add<T extends Disposable>(item: T): T;
  add(fn: Disposer): Disposable;
  add(item: Disposable | Disposer): Disposable {
    const d: Disposable = typeof item === 'function' ? toDisposable(item) : item;
    if (this.disposed) {
      void this.safeDispose(d);
      return d;
    }
    this.items.push(d);
    return d;
  }

  get size(): number {
    return this.items.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items.reverse();
    this.items = [];

    let firstError: unknown;
    for (const item of items) {
      try {
        await item.dispose();
      } catch (err) {
        // 异常隔离：继续释放其余资源，只记住第一个错误
        if (firstError === undefined) firstError = err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private async safeDispose(d: Disposable): Promise<void> {
    try {
      await d.dispose();
    } catch {
      // store 已处于 disposed 状态，吞掉错误避免二次抛出打断调用方
    }
  }
}
