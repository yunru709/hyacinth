/**
 * 本体注册表（AssemblyRegistry）——「出厂架构」的只读查询面。
 *
 * 收编三处分散的装配记录（不复制数据，全部由装配层注入，supervisor 零业务依赖）：
 *  - gateway/assembly-graph.ts 的 ASSEMBLY_GRAPH → instance/plugin/shared-ref 条目
 *  - orchestrator/stage-registry.ts 槽位贡献 + kernel.pipeline 出厂默认 → slot 条目
 *  - orchestrator/stage-services.ts 的 StageServiceMap → service 条目
 *
 * 与扩展注册表（extension-registry.ts）的关系：本体 = 不可变出厂图，
 * 扩展 = 运行时可变视图，两者 join 即完整架构快照。
 */

// ── Types ──────────────────────────────────────────────────────────

export type AssemblyKind = 'instance' | 'plugin' | 'shared-ref' | 'phase' | 'slot' | 'service';

export interface AssemblyEntry {
  id: string;
  kind: AssemblyKind;
  /** 施工锚点（构造表达式/装配位置） */
  anchor?: string;
  needs?: string;
  provides?: string;
  phase?: string;
  /** 槽位/服务的出厂默认实现 */
  defaultImpl?: string;
  note?: string;
}

/** 装配层注入的数据源（gateway 构造，本类不 import gateway） */
export interface AssemblyRegistryInputs {
  graphEntries: AssemblyEntry[];
  slotEntries: AssemblyEntry[];
  serviceEntries: AssemblyEntry[];
}

// ── Registry ───────────────────────────────────────────────────────

export class AssemblyRegistry {
  private readonly entries = new Map<string, AssemblyEntry>();

  constructor(inputs: AssemblyRegistryInputs) {
    for (const entry of [...inputs.graphEntries, ...inputs.slotEntries, ...inputs.serviceEntries]) {
      if (this.entries.has(entry.id)) {
        throw new Error(`AssemblyRegistry: duplicate entry id "${entry.id}"`);
      }
      this.entries.set(entry.id, entry);
    }
  }

  list(kind?: AssemblyKind): AssemblyEntry[] {
    const all = [...this.entries.values()];
    if (!kind) return all;
    return all.filter((e) => e.kind === kind);
  }

  get(id: string): AssemblyEntry | undefined {
    return this.entries.get(id);
  }

  /** 文本视图：按装配阶段分组的一屏出厂图 */
  describe(): string {
    const PHASES = ['P-A', 'P-B', 'P-C', 'P-D', 'P-E', 'P-F'];
    const lines: string[] = [];
    const entries = [...this.entries.values()];
    for (const phase of PHASES) {
      const group = entries.filter((e) => e.phase === phase);
      if (group.length === 0) continue;
      lines.push(`── ${phase} ──`);
      for (const e of group) {
        const impl = e.defaultImpl ? ` = ${e.defaultImpl}` : '';
        const prov = e.provides ? ` → ${e.provides}` : '';
        lines.push(`  ${e.id} [${e.kind}]${impl}${prov}${e.note ? `  # ${e.note}` : ''}`);
      }
    }
    const noPhase = entries.filter((e) => !e.phase);
    if (noPhase.length > 0) {
      lines.push('── unphased ──');
      for (const e of noPhase) {
        lines.push(`  ${e.id} [${e.kind}]${e.defaultImpl ? ` = ${e.defaultImpl}` : ''}`);
      }
    }
    return lines.join('\n');
  }
}
