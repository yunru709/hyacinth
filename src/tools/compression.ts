/**
 * trigger_compression — 手动触发上下文压缩，支持压缩强度调节。
 *
 * 参数：
 *   level: 'normal'(默认) | 'deep'
 *   template: 自定义压缩模板（仅 level='deep' 时生效）
 *
 * deep 模式下，工具会将 ~/.agent/prompts/summary.md 临时替换为激进模板，
 * 压缩完成后自动恢复原始内容。
 */
import type { Tool } from './interface.js';
import type { AgentLoop } from '../orchestrator/loop.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 内置深度压缩模板 — 极度精简，只保留关键信息 */
const DEEP_SUMMARY_TEMPLATE = `请根据以下对话历史生成极度精简的结构化摘要。严格遵守以下规则：

## ✅ 已完成
[每个已完成任务最多 1 行，禁止展开实现细节]

## 🔄 进行中/待办
[每个未完成任务最多 1 行，标注当前进度]

## 关键决策
[仅记录不可逆的重大决策，每条最多 1 行]

## 文件变更
[仅列出修改过的文件路径，不写变更内容]

禁止输出以下章节：对话时间线、重要发现、当前状态。
总输出不超过 500 字。`;

function getSummaryPath(): string {
  return path.join(os.homedir(), '.agent', 'prompts', 'summary.md');
}

export function createTriggerCompressionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'trigger_compression',
    description:
      '手动触发上下文压缩以释放 Token 空间。' +
      'level=normal 使用当前 summary.md 模板（默认）；' +
      'level=deep 使用内置激进模板或 template 参数指定的自定义模板，压缩完成后自动恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['normal', 'deep'],
          description: '压缩强度：normal=标准压缩（默认），deep=激进压缩，临时替换压缩模板，完成后自动恢复。',
        },
        template: {
          type: 'string',
          description: '自定义压缩模板内容。仅在 level=deep 时生效，覆盖内置激进模板。压缩完成后自动恢复为原始 summary.md。',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const level = (args.level as string) || 'normal';
      const customTemplate = args.template as string | undefined;
      const loop = agentLoop as any;

      if (level === 'deep') {
        const summaryPath = getSummaryPath();
        // 备份原始内容
        try {
          loop._deepCompressOriginal = fs.readFileSync(summaryPath, 'utf-8');
        } catch {
          loop._deepCompressOriginal = null; // 无自定义模板，恢复时删除文件
        }
        // 写入深度模板
        const tmpl = customTemplate || DEEP_SUMMARY_TEMPLATE;
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        fs.writeFileSync(summaryPath, tmpl, 'utf-8');
        loop._deepCompressRestore = true;
      }

      loop.needsCompression = true;

      if (level === 'deep') {
        return customTemplate
          ? 'Deep compression triggered with custom template. Summary template temporarily replaced — will auto-restore after compression completes.'
          : 'Deep compression triggered. Summary template temporarily replaced with aggressive mode — will auto-restore after compression completes.';
      }
      return 'Compression triggered. Will execute before the next turn.';
    },
  };
}
