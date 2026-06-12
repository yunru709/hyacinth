/**
 * Slash Command 定义接口 — 门面层
 *
 * 类型定义和查询函数委托到 CommandRegistry 单例，
 * 命令数据由内置定义 + commands.json 外部配置合并而成，支持热重载。
 */

import { CommandRegistry, CATEGORY_LABELS } from './command-registry.js';
import type { SlashCommandCategory, SlashCommandDef } from './command-registry.js';

// ─── Types (re-export for backwards compat) ────────────────────────

export type { SlashCommandCategory, SlashCommandDef };
export { CATEGORY_LABELS };

// ─── Lazy registry access ──────────────────────────────────────────

function registry(): CommandRegistry {
  return CommandRegistry.getInstance();
}

// ─── Query Functions (delegate to registry) ────────────────────────

export function getSlashCommands(): SlashCommandDef[] {
  return registry().getAll();
}

export function getCommandsByCategory(): Map<SlashCommandCategory, SlashCommandDef[]> {
  return registry().getByCategory();
}

export function filterCommands(query: string): SlashCommandDef[] {
  return registry().filter(query);
}

export function findCommand(name: string): SlashCommandDef | undefined {
  return registry().find(name);
}

export function getCategoryLabel(category: SlashCommandCategory): string {
  return CATEGORY_LABELS[category] || category;
}