/**
 * 知识库工具 — 暴露给 LLM 的操作接口
 *
 * kb_add    — 导入文件/文件夹
 * kb_list   — 列出所有已索引文档
 * kb_delete — 删除指定文档（同时清理 files/ 中的文件）
 * kb_update — 重新索引（可选路径，不传则全量同步 files/ 目录）
 *
 * 所有工具在知识库关闭时统一返回提示，模型无法绕过。
 */

import fs from 'node:fs';
import type { Tool } from '../tools/interface.js';
import type { KnowledgeBase } from './store.js';
import { indexFile, indexDirectory, syncDirectory } from './indexer.js';

// ── 守卫：检查知识库是否可用 ──────────────────────────────────────

function kbGuard(kb: KnowledgeBase): string | null {
  if (kb.enabled) return null;
  if (!kb.zone4Enabled) {
    return '知识库不可用：Zone 4 已关闭。请先执行 /zone4 on 开启 Zone 4，再执行 /kb on 开启知识库。';
  }
  return '知识库未开启。请执行 /kb on 开启知识库后再使用此工具。';
}

// ── kb_add ─────────────────────────────────────────────────────────

export function createKbAddTool(
  kb: KnowledgeBase,
  kbFilesDir?: string,
): Tool {
  return {
    name: 'kb_add',
    description:
      'Import files or directories into the knowledge base for indexing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径或文件夹路径' },
      },
      required: ['path'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = kbGuard(kb);
      if (blocked) return blocked;

      const targetPath = args.path as string;
      if (!targetPath) return 'Error: path is required.';

      try {
        const stat = fs.statSync(targetPath);
        let count = 0;
        const opts = kbFilesDir ? { kbFilesDir } : {};
        if (stat.isDirectory()) {
          count = await indexDirectory(kb, targetPath, opts);
        } else if (stat.isFile()) {
          count = await indexFile(kb, targetPath, opts);
        } else {
          return 'Error: path is not a file or directory.';
        }
        const fileInfo = kbFilesDir ? `（已复制到 ${kbFilesDir}）` : '';
        return `已导入 ${count} 个文件到知识库${fileInfo}。当前共 ${kb.count()} 条记录。`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── kb_list ─────────────────────────────────────────────────────────

export function createKbListTool(kb: KnowledgeBase): Tool {
  return {
    name: 'kb_list',
    description:
      'List all indexed documents in the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      const blocked = kbGuard(kb);
      if (blocked) return blocked;

      try {
        const docs = kb.list();
        if (docs.length === 0) return '知识库为空。使用 kb_add 导入文件。';
        const lines = docs.map((d) => {
          const title = d.title || '(无标题)';
          const src = d.source ? ` — ${d.source}` : '';
          const date = d.created_at ? ` [${d.created_at}]` : '';
          return `- \`${d.id}\` **${title}**${src}${date}`;
        });
        return `共 ${docs.length} 条记录：\n${lines.join('\n')}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── kb_delete ───────────────────────────────────────────────────────

export function createKbDeleteTool(
  kb: KnowledgeBase,
  kbFilesDir?: string,
): Tool {
  return {
    name: 'kb_delete',
    description:
      'Delete a document from the knowledge base by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文档 ID（从 kb_list 获取）' },
      },
      required: ['id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = kbGuard(kb);
      if (blocked) return blocked;

      const docId = args.id as string;
      if (!docId) return 'Error: id is required. Use kb_list to find document IDs.';

      try {
        const docs = kb.list();
        const doc = docs.find((d) => d.id === docId);
        if (!doc) return `未找到文档 "${docId}"。使用 kb_list 查看可用 ID。`;

        const ok = kb.remove(docId);
        if (!ok) return `删除失败: "${docId}"`;

        let fileRemoved = false;
        if (kbFilesDir && doc.source && doc.source.startsWith(kbFilesDir)) {
          try {
            if (fs.existsSync(doc.source)) {
              fs.unlinkSync(doc.source);
              fileRemoved = true;
            }
          } catch {
            // 删文件失败不影响索引删除
          }
        }

        const extra = fileRemoved ? '（已同时删除磁盘文件）' : '';
        return `已删除: "${doc.title || docId}"${extra}。当前共 ${kb.count()} 条记录。`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── kb_update ───────────────────────────────────────────────────────

export function createKbUpdateTool(
  kb: KnowledgeBase,
  kbFilesDir?: string,
): Tool {
  return {
    name: 'kb_update',
    description:
      'Re-index the knowledge base. Pass a path to re-index specific files, omit for full sync.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            '可选。要重新索引的文件或目录路径。不传则全量同步知识库目录。',
        },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const blocked = kbGuard(kb);
      if (blocked) return blocked;

      try {
        const targetPath = (args.path as string) || '';

        if (!targetPath && kbFilesDir) {
          const { added, removed } = await syncDirectory(kb.retriever, kbFilesDir);
          if (added === 0 && removed === 0) {
            return `知识库已是最新。当前共 ${kb.count()} 条记录。`;
          }
          return `同步完成：新增 ${added} 条，移除 ${removed} 条。当前共 ${kb.count()} 条记录。`;
        }

        if (targetPath) {
          if (!fs.existsSync(targetPath)) {
            return `Error: 路径不存在: ${targetPath}`;
          }
          const stat = fs.statSync(targetPath);
          const opts = kbFilesDir ? { kbFilesDir } : {};
          let count = 0;
          if (stat.isDirectory()) {
            count = await indexDirectory(kb, targetPath, opts);
          } else {
            count = await indexFile(kb, targetPath, opts);
          }
          return `已重新索引 ${count} 个文件。当前共 ${kb.count()} 条记录。`;
        }

        return '请指定 path 参数，或在知识库目录已配置时留空以全量同步。';
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}


// ── kb_toggle ─────────────────────────────────────────────────────

export function createKbToggleTool(
  kb: KnowledgeBase,
  contextComposer?: { activeConditions: Set<string> },
): Tool {
  return {
    name: 'kb_toggle',
    description:
      'Toggle the knowledge base on/off. Turning it on also enables Zone 4.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['on', 'off'],
          description: '"on" 开启知识库，"off" 关闭',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const action = args.action as string;
        if (action === 'on') {
          if (kb.enabled) return '知识库已开启。';
          if (!kb.zone4Enabled) {
            kb.setZone4Enabled(true);
            if (contextComposer) {
              contextComposer.activeConditions.add('zone4_enabled');
            }
          }
          kb.enable();
          return '知识库已开启（Zone 4 已同步开启）。';
        }
        if (action === 'off') {
          if (!kb.enabled) return '知识库已关闭。';
          kb.disable();
          return '知识库已关闭（Zone 4 保持开启）。';
        }
        return 'Error: action 必须是 "on" 或 "off"。';
      } catch (err) {
        return 'Error: ' + (err instanceof Error ? err.message : String(err));
      }
    },
  };
}
