// ============================================================
// UI 协议层 — 命令域（command.*）
// ============================================================
// 覆盖 UI 对命令系统的操作：
//   command.list     导出命令树（按分类分组：category/name/description/args）
//   command.execute  执行指定命令（分派到后端生效命令子集）
//
// 设计定位：命令域是"面向终端用户的聚合操作"层，与各功能域
// （config.*/model.*/session.*）并存 —— UI 精细交互优先用功能域，
// 命令域保留"会话内斜杠命令/脚本化操作"的语义。
//
// 执行策略：
//   - 注入 executor 的：委托执行（model/config/session 类后端命令）
//   - 纯 UI 命令（clear/help/exit 等本地命令）：标记 unsupported，
//     由 UI 客户端本地处理，不落到协议层
//   - 未注入 executor 的后端命令：返回 backend-not-wired 标记
//
// 依赖结构化 CommandRegistryLike（真实 CommandRegistry 兼容）。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { CommandDef } from '../types.js';

// ────────────────────────────────────────────────────────────
// 结构化命令定义（真实 SlashCommandDef 兼容）
// ────────────────────────────────────────────────────────────

export interface CommandDefLike {
  name: string;
  description: string;
  icon?: string;
  category?: string;
  args?: string;
  argOptions?: string[];
  executeLocal?: boolean;
  deprecated?: boolean;
  children?: CommandDefLike[];
}

/** 结构化命令注册表（真实 CommandRegistry 兼容） */
export interface CommandRegistryLike {
  /** 按分类分组（含子命令，继承父命令分类） */
  getByCategory(): Map<string, CommandDefLike[]>;
  /** 查找命令（支持路径名如 session/load） */
  find(name: string): CommandDefLike | undefined;
}

/** 命令执行器：由桥接层注入，处理后端生效命令 */
export type CommandExecutor = (
  command: CommandDefLike,
  args: string,
  /** 完整命令路径（如 'model/online/anthropic/claude-sonnet-5'）——find 返回的叶子 def 会丢路径，需完整名分派 */
  fullName?: string,
) => unknown | Promise<unknown>;

// ────────────────────────────────────────────────────────────
// 命令域选项
// ────────────────────────────────────────────────────────────

export interface CommandDomainOptions {
  /** 命令注册表（真实 CommandRegistry） */
  registry: CommandRegistryLike;
  /** 后端命令执行器（可选）。缺省时后端命令返回 backend-not-wired。 */
  executor?: CommandExecutor;
}

/** 分类展示标签（对齐 CommandRegistry 的 CATEGORY_LABELS） */
const CATEGORY_LABELS: Record<string, string> = {
  system: '系统',
  session: '会话',
  model: '模型',
  config: '配置',
  repair: '修复',
  tools: '工具',
  mode: '模式',
};

/** 纯 UI 本地命令：协议层不执行，标记 unsupported 由 UI 客户端本地处理 */
const UI_ONLY_COMMANDS = new Set(['clear', 'help', 'exit', 'restart', 'new']);

// ────────────────────────────────────────────────────────────
// 命令域工厂
// ────────────────────────────────────────────────────────────

export function createCommandDomain(options: CommandDomainOptions): DomainHandler {
  const { registry, executor } = options;

  /** SlashCommandDefLike → 协议 CommandDef（剥离执行细节） */
  const toCommandDef = (cmd: CommandDefLike): CommandDef => ({
    name: cmd.name,
    description: cmd.description,
    icon: cmd.icon,
    category: cmd.category,
    args: cmd.args,
    argOptions: cmd.argOptions,
    executeLocal: cmd.executeLocal,
    deprecated: cmd.deprecated,
    children: cmd.children ? cmd.children.map(toCommandDef) : undefined,
  });

  return {
    // ── command.list ───────────────────────────────────────
    list: (): {
      categories: Array<{ category: string; label: string; commands: CommandDef[] }>;
      total: number;
    } => {
      const byCategory = registry.getByCategory();
      const categories: Array<{ category: string; label: string; commands: CommandDef[] }> = [];
      let total = 0;

      for (const [category, cmds] of byCategory) {
        const commandDefs = cmds.map(toCommandDef);
        total += commandDefs.length;
        categories.push({
          category,
          label: CATEGORY_LABELS[category] ?? category,
          commands: commandDefs,
        });
      }

      return { categories, total };
    },

    // ── command.execute ────────────────────────────────────
    async execute(params: unknown): Promise<unknown> {
      const { name, args = '' } = (params ?? {}) as { name?: string; args?: string };
      if (!name) throw new Error('command.execute requires "name"');

      const def = registry.find(name);
      if (!def) {
        return {
          ok: false,
          unsupported: false,
          reason: 'command-not-found',
          command: name,
        };
      }

      // 纯 UI 本地命令 → 标记 unsupported，由 UI 客户端本地处理
      if (def.executeLocal || UI_ONLY_COMMANDS.has(def.name)) {
        return {
          ok: true,
          unsupported: true,
          reason: 'ui-only',
          command: name,
        };
      }

      // 有注入执行器 → 委托执行（传完整命令路径供分派）
      if (executor) {
        const result = await executor(def, args, name);
        return { ok: true, result, command: name };
      }

      // 无执行器 → 后端命令未接入
      return {
        ok: true,
        unsupported: true,
        reason: 'backend-not-wired',
        command: name,
      };
    },
  };
}
