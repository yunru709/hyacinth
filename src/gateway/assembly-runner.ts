/**
 * assembly-runner.ts —— 装配贡献（assembly contribution）原语（P6-1 交付物）。
 *
 * 目的：把 factory.ts 的装配顺序从「注释纪律」变成「声明 + 拓扑校验」。
 * 一条贡献声明 needs（消费什么）与 provides（产出什么），运行器保证：
 *
 *   1. 缺依赖 fail-fast：needs 中既无 factory 顺序代码 provide()、又无任何贡献
 *      provides 的键 → 抛错。替代「顺序错了不报错，只是行为静默不对」。
 *   2. 拓扑排序（Kahn）：A provides 了 B 的 needs → A 先于 B 执行。
 *   3. 环检测：贡献相互等待无法推进 → 抛错，解析期失败而非运行期静默。
 *
 * 与 PluginHost 的关系：本原语只管「装配顺序」，不管「生命周期」——贡献的
 * mount 内部仍走 PluginHost.mount 等既有机制，卸载回滚能力零损失。
 *
 * 设计边界（X1 最小面，P6-1）：
 * - deps 值来自 factory 顺序代码 provide() 的真实对象（闭包注入语义保留，
 *   见 assembly-graph.ts 头部「类 1 懒求值」说明）或贡献 mount 的返回值；
 * - 共享可变引用（loopRef/companionVoice 等「建完写回」）不属于本原语表达
 *   范围，仍由 factory 顺序回填（assembly-graph.ts 头部「类 3」），P6-2 再议。
 *
 * P6-2/P6-3 服务拆分时，同一原语承载更多装配条目（assembly-graph.ts 为施工图）。
 */

/** 一条装配贡献。mount 的返回值按 provides 键登记为可消费值。 */
export interface AssemblyContribution {
  /** 贡献 id（同批内唯一，重复报错） */
  id: string;
  /** 消费键：由 factory 顺序代码 provide() 或其它贡献 provides() */
  needs: string[];
  /** 产出键（可选）：满足其它贡献的 needs；值由 mount 返回值给出 */
  provides?: string[];
  /**
   * 装配实现。deps[need] = 对应值（缺依赖在 run 期已校验，不会走到这里）。
   * 返回对象时，其键必须 ⊆ provides（提供值，run 期校验）；否则返回 void。
   */
  mount(deps: Record<string, unknown>):
    | void
    | Record<string, unknown>
    | Promise<void | Record<string, unknown>>;
}

/** run() 的结果：每个贡献提供的键 → 值（供 factory 后续取用） */
export type AssemblyResults = Map<string, unknown>;

export class AssemblyRunner {
  private provided = new Map<string, unknown>();
  /** 已执行过的贡献 id（多批 run：每个 id 只执行一次，防副作用重复） */
  private executed = new Set<string>();

  /** factory 顺序代码在关键节点登记已就位对象（如 loop 创建后 provide('loop', loop)） */
  provide(key: string, value: unknown): void {
    this.provided.set(key, value);
  }

  has(key: string): boolean {
    return this.provided.has(key);
  }

  /**
   * 拓扑执行贡献清单。
   *
   * 顺序：先执行 needs 全部就绪的贡献；其 provides 登记后就绪集合扩大，
   * 解锁依赖它的贡献。无法推进时按「缺依赖 / 环」两类给出逐条诊断后抛错。
   *
   * **增量多批**：本 run 产出的 provides 会写回 `this.provided` —— 后续再次
   * run() 可消费前一批的产出（factory 在各时序点分批装配）。同一贡献 id 在
   * 整个 runner 生命周期只执行一次（重复 run 报错，防副作用重复）。
   */
  async run(contribs: AssemblyContribution[]): Promise<AssemblyResults> {
    if (contribs.length === 0) return new Map();

    // 重复执行防御：多批 run 中，已执行过的贡献 id 不得再次出现
    for (const c of contribs) {
      if (this.executed.has(c.id)) {
        throw new Error(
          `[assembly-runner] 贡献 "${c.id}" 已在本 runner 执行过（多批 run 中每个 id 只执行一次）`,
        );
      }
    }

    // 唯一性校验：id 与 provides 键均不得重复（重复 = 歧义，解析期报错）
    const ids = new Set<string>();
    for (const c of contribs) {
      if (ids.has(c.id)) {
        throw new Error(`[assembly-runner] duplicate contribution id "${c.id}"`);
      }
      ids.add(c.id);
    }
    const providedKeys = new Map<string, string>();
    for (const c of contribs) {
      for (const k of c.provides ?? []) {
        const owner = providedKeys.get(k);
        if (owner) {
          throw new Error(`[assembly-runner] "${k}" provided by both "${owner}" and "${c.id}"`);
        }
        if (this.provided.has(k)) {
          throw new Error(`[assembly-runner] "${k}" already provided by factory code, conflict with "${c.id}"`);
        }
        providedKeys.set(k, c.id);
      }
    }

    // 就绪集合 = factory 已 provide 的值 + 此前各批贡献已产出的值（增量多批）
    const resolved = new Map<string, unknown>(this.provided);
    const done = new Set<string>();
    const results: AssemblyResults = new Map();

    const pending = [...contribs];
    while (pending.length > 0) {
      // 找 needs 全部就绪的贡献（保持声明序，结果可预期）
      const idx = pending.findIndex((c) => c.needs.every((k) => resolved.has(k)));
      if (idx < 0) {
        // 无法推进：区分「真缺依赖」（无人提供）与「等待他人」（有提供者但未轮到/成环）
        const missingCount = pending.filter((c) =>
          c.needs.some((k) => !resolved.has(k) && !providedKeys.has(k)),
        ).length;
        const detail = pending
          .map((c) => {
            const missing = c.needs.filter((k) => !resolved.has(k) && !providedKeys.has(k));
            const waiting = c.needs
              .filter((k) => !resolved.has(k) && providedKeys.has(k))
              .map((k) => `${k}←${providedKeys.get(k)}`);
            const parts = [
              ...missing.map((k) => `缺依赖: ${k}（无贡献可提供）`),
              ...(waiting.length > 0 ? [`等待: ${waiting.join(', ')}`] : []),
            ];
            return `  ${c.id} ${parts.join('；')}`;
          })
          .join('\n');
        throw new Error(
          `[assembly-runner] 装配无法推进（${missingCount > 0 ? '缺失依赖' : '环'}），共 ${pending.length} 条未执行：\n${detail}`,
        );
      }

      const contrib = pending[idx];
      pending.splice(idx, 1);
      const deps: Record<string, unknown> = {};
      for (const k of contrib.needs) deps[k] = resolved.get(k);

      const out = await contrib.mount(deps);
      done.add(contrib.id);
      this.executed.add(contrib.id);

      if (out && typeof out === 'object') {
        for (const [k, v] of Object.entries(out)) {
          if (!providedKeys.has(k)) {
            throw new Error(
              `[assembly-runner] "${contrib.id}" 返回了未声明的键 "${k}"` +
              `（provides 声明: ${(contrib.provides ?? []).join(', ') || '无'}）`,
            );
          }
          resolved.set(k, v);
          results.set(k, v);
          this.provided.set(k, v); // 增量多批：产出持久化，后续 run 可消费
        }
      }
    }

    return results;
  }
}
