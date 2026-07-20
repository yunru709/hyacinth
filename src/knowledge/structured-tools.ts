/**
 * 结构化知识库工具 — 合并为单一 kb_structured 工具，通过 action 参数区分操作。
 *
 *   add    — 结构化写入（1-10 条）
 *   update — 更新条目
 *   delete — 删除条目
 *   list   — 列出条目
 */

import type { Tool } from '../tools/interface.js';
import type { StructuredStore, EntryCategory } from './structured-store.js';

function guard(store: () => StructuredStore, enabled: () => boolean): string | null {
  if (!enabled()) return '知识库未开启。请执行 /kb on。';
  return null;
}

export function createStructuredTool(getStore: () => StructuredStore, enabled: () => boolean): Tool {
  return {
    name: 'kb_structured',
    description:
      'Manage structured knowledge entries. Supports 4 actions:\n' +
      '  "add"    — add 1-10 entries at once. Use english_underscore ids, 2-5 tags, content ≤200 chars.\n' +
      '  "update" — update an entry by id. Only pass the fields you want to change.\n' +
      '  "delete" — delete an entry by id.\n' +
      '  "list"   — list all entries, optionally filtered by category.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'delete', 'list'],
          description: '操作类型',
        },
        // ── add 参数 ──
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
          description: '条目数组，1-10 条（action=add 时必填）',
        },
        // ── update / delete 参数 ──
        id: { type: 'string', description: '条目 ID（action=update/delete 时必填）' },
        title: { type: 'string', description: '新标题（action=update 时可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（action=update 时可选）' },
        category: { type: 'string', enum: ['api', 'config', 'guide', 'reference', 'code'], description: '分类（可选）' },
        content: { type: 'string', description: '新内容（action=update 时可选）' },
        ctx_before: { type: 'string', description: '前置上下文（action=update 时可选）' },
        ctx_after: { type: 'string', description: '后续关联（action=update 时可选）' },
        refs: { type: 'array', items: { type: 'string' }, description: '关联条目（action=update 时可选）' },
        source: { type: 'string', description: '来源（action=update 时可选）' },
      },
      required: ['action'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = guard(getStore, enabled);
      if (blocked) return blocked;

      const action = args.action as string;

      try {
        switch (action) {
          case 'add':
            return handleAdd(getStore(), args);
          case 'update':
            return handleUpdate(getStore(), args);
          case 'delete':
            return handleDelete(getStore(), args);
          case 'list':
            return handleList(getStore(), args);
          default:
            return `Unknown action: "${action}". Supported: add, update, delete, list.`;
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── 各 action 实现 ──────────────────────────────────────────────────────

function handleAdd(store: StructuredStore, args: Record<string, unknown>): string {
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
}

function handleUpdate(store: StructuredStore, args: Record<string, unknown>): string {
  const id = args.id as string;
  if (!id) return 'Error: id 是必填项（action=update）。';

  const existing = store.get(id);
  if (!existing) return `未找到条目 "${id}"。使用 kb_structured action=list 查看可用 ID。`;

  const fields: Record<string, unknown> = {};
  for (const k of ['title', 'tags', 'category', 'content', 'ctx_before', 'ctx_after', 'refs', 'source']) {
    if (args[k] !== undefined) fields[k] = args[k];
  }

  const ok = store.update(id, fields);
  return ok ? `已更新: ${id}` : `更新失败: ${id}`;
}

function handleDelete(store: StructuredStore, args: Record<string, unknown>): string {
  const id = args.id as string;
  if (!id) return 'Error: id 是必填项（action=delete）。';

  const existing = store.get(id);
  if (!existing) return `未找到条目 "${id}"。`;

  store.remove(id);
  return `已删除: "${existing.title || id}"。当前共 ${store.count()} 条。`;
}

function handleList(store: StructuredStore, args: Record<string, unknown>): string {
  const cat = args.category as EntryCategory | undefined;
  const entries = store.list(cat);
  if (entries.length === 0) return '知识库为空。使用 kb_structured action=add 添加条目。';
  const lines = entries.map(e => {
    const tags = e.tags.join(', ');
    return `- \`${e.id}\` [${e.category}] **${e.title}** — ${e.content.slice(0, 80)}${e.content.length > 80 ? '...' : ''} | tags: ${tags}`;
  });
  return `共 ${entries.length} 条：\n${lines.join('\n')}`;
}
