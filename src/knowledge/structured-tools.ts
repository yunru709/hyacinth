/**
 * 结构化知识库工具 — Agent 使用的 4 个工具
 *
 * kb_add_structured   — 结构化写入
 * kb_update_structured — 更新条目
 * kb_delete_structured — 删除条目
 * kb_list_structured  — 列出条目
 */

import type { Tool } from '../tools/interface.js';
import type { StructuredStore, EntryCategory } from './structured-store.js';

// ── 守卫 ────────────────────────────────────────────────────────────

function guard(store: StructuredStore, enabled: () => boolean): string | null {
  if (!enabled()) return '知识库未开启。请执行 /kb on。';
  return null;
}

// ── kb_add_structured ──────────────────────────────────────────────

export function createAddStructuredTool(store: StructuredStore, enabled: () => boolean): Tool {
  return {
    name: 'kb_add_structured',
    description:
      '结构化写入知识库条目。由 Agent 分析原始内容后提炼为结构化条目。' +
      '每次可写入 1-10 条。id 应使用英文下划线命名（如 api_create_thread）。' +
      'tags 是精确关键词（2-5 个），用户输入中包含这些词时自动匹配。' +
      'content 不超过 200 字，核心信息即可。',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '唯一标识，英文下划线命名' },
              title: { type: 'string', description: '条目标题，一句话' },
              tags: { type: 'array', items: { type: 'string' }, description: '关键词标签，2-5 个' },
              category: { type: 'string', enum: ['api', 'config', 'guide', 'reference', 'code'], description: '分类' },
              content: { type: 'string', description: '核心内容，不超过 200 字' },
              ctx_before: { type: 'string', description: '前置上下文（可选）' },
              ctx_after: { type: 'string', description: '后续关联（可选）' },
              refs: { type: 'array', items: { type: 'string' }, description: '关联条目 ID 列表（可选）' },
              source: { type: 'string', description: '来源原始文件（可选）' },
            },
            required: ['id', 'title', 'tags', 'content'],
          },
          minItems: 1,
          maxItems: 10,
          description: '条目数组，1-10 条',
        },
      },
      required: ['entries'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = guard(store, enabled);
      if (blocked) return blocked;

      try {
        const entries = args.entries as Array<Record<string, unknown>> | undefined;
        if (!entries || !Array.isArray(entries) || entries.length === 0) {
          return 'Error: entries 数组不能为空，至少提供 1 条。';
        }

        let added = 0;
        const ids: string[] = [];
        for (const e of entries) {
          store.add({
            id: e.id as string,
            title: e.title as string,
            tags: e.tags as string[],
            category: e.category as EntryCategory,
            content: e.content as string,
            ctx_before: e.ctx_before as string,
            ctx_after: e.ctx_after as string,
            refs: e.refs as string[],
            source: e.source as string,
          });
          added++;
          ids.push(e.id as string);
        }
        return `已写入 ${added} 条。ID: ${ids.join(', ')}。当前共 ${store.count()} 条。`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── kb_update_structured ───────────────────────────────────────────

export function createUpdateStructuredTool(store: StructuredStore, enabled: () => boolean): Tool {
  return {
    name: 'kb_update_structured',
    description:
      '更新已有结构化条目。按 id 更新，只传需要修改的字段，不传的保持不变。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要更新的条目 ID' },
        title: { type: 'string', description: '新标题（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（可选）' },
        category: { type: 'string', enum: ['api', 'config', 'guide', 'reference', 'code'] },
        content: { type: 'string', description: '新内容（可选）' },
        ctx_before: { type: 'string', description: '前置上下文（可选）' },
        ctx_after: { type: 'string', description: '后续关联（可选）' },
        refs: { type: 'array', items: { type: 'string' }, description: '关联条目（可选）' },
        source: { type: 'string', description: '来源（可选）' },
      },
      required: ['id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = guard(store, enabled);
      if (blocked) return blocked;

      try {
        const id = args.id as string;
        if (!id) return 'Error: id 是必填项。';

        const existing = store.get(id);
        if (!existing) return `未找到条目 "${id}"。使用 kb_list_structured 查看可用 ID。`;

        const fields: Record<string, unknown> = {};
        for (const k of ['title', 'tags', 'category', 'content', 'ctx_before', 'ctx_after', 'refs', 'source']) {
          if (args[k] !== undefined) fields[k] = args[k];
        }

        const ok = store.update(id, fields);
        return ok ? `已更新: ${id}` : `更新失败: ${id}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── kb_delete_structured ───────────────────────────────────────────

export function createDeleteStructuredTool(store: StructuredStore, enabled: () => boolean): Tool {
  return {
    name: 'kb_delete_structured',
    description: '删除指定条目（按 ID）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 ID' },
      },
      required: ['id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = guard(store, enabled);
      if (blocked) return blocked;

      try {
        const id = args.id as string;
        const existing = store.get(id);
        if (!existing) return `未找到条目 "${id}"。`;

        store.remove(id);
        return `已删除: "${existing.title || id}"。当前共 ${store.count()} 条。`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── kb_list_structured ─────────────────────────────────────────────

export function createListStructuredTool(store: StructuredStore, enabled: () => boolean): Tool {
  return {
    name: 'kb_list_structured',
    description: '列出知识库中的所有结构化条目。可选按 category 筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['api', 'config', 'guide', 'reference', 'code'], description: '按分类筛选（可选）' },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = guard(store, enabled);
      if (blocked) return blocked;

      try {
        const cat = args.category as EntryCategory | undefined;
        const entries = store.list(cat);
        if (entries.length === 0) return '知识库为空。使用 kb_add_structured 添加条目。';
        const lines = entries.map(e => {
          const tags = e.tags.join(', ');
          return `- \`${e.id}\` [${e.category}] **${e.title}** — ${e.content.slice(0, 80)}${e.content.length > 80 ? '...' : ''} | tags: ${tags}`;
        });
        return `共 ${entries.length} 条：\n${lines.join('\n')}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
