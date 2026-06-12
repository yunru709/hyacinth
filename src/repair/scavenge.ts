import type { ToolCall } from '../types.js';

const TOOL_CALL_PATTERNS: RegExp[] = [
  /\{\s*"name"\s*:\s*"([^"]+)",\s*"(?:arguments|input)"\s*:\s*(\{[^}]+\})\s*\}/g,
  /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g,
  /<function=([a-z_][\w]*)>\s*(\{[\s\S]*?\})\s*<\/function>/g,
  /\n?```json\s*\n(\{[\s\S]*?\})\s*\n```\n?/g,
];

function extractJsonObjects(text: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const pattern of TOOL_CALL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const jsonStr = match[1] || match[2];
      if (!jsonStr) continue;
      if (seen.has(jsonStr)) continue;
      seen.add(jsonStr);

      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
          results.push(parsed);
        }
      } catch {
        // 不是有效 JSON，跳过
      }
    }
  }

  return results;
}

function generateToolCallId(name: string, args: Record<string, unknown>): string {
  const hash = JSON.stringify(args).length.toString(36) + Date.now().toString(36).slice(-4);
  return `scvg_${name}_${hash}`;
}

function isDuplicate(existing: ToolCall[], name: string, args: Record<string, unknown>): boolean {
  return existing.some(
    tc => tc.name === name && JSON.stringify(tc.input) === JSON.stringify(args),
  );
}

/**
 * 从 thinking/content 文本中回收遗漏的工具调用。
 *
 * 某些模型（尤其是 DeepSeek R1）可能在 reasoning/thinking 块中生成
 * 完整的工具调用 JSON，但忘记在正式的 tool_calls 中声明。
 * Scavenge 扫描两个通道（thinking + text），提取遗漏的调用并补充到 toolCalls 数组。
 *
 * @param thinkingParts - 流式收集的 thinking 块内容
 * @param textParts - 流式收集的 text 块内容
 * @param existingCalls - 模型正式声明的 tool_calls（避免重复）
 * @param allowedNames - 可选的工具名白名单，null 表示允许所有
 * @returns 合并后的 ToolCall 数组（原有 + 回收的）
 */
export function scavengeToolCalls(
  thinkingParts: string[],
  textParts: string[],
  existingCalls: ToolCall[],
  allowedNames?: Set<string> | null,
): ToolCall[] {
  const combined = [...thinkingParts, ...textParts].filter(Boolean).join('\n');
  if (!combined.trim()) return existingCalls;

  const scavenged: ToolCall[] = [];
  const found = extractJsonObjects(combined);

  for (const obj of found) {
    const name = obj.name as string;
    const args = (obj.arguments || obj.input || {}) as Record<string, unknown>;

    if (!name) continue;

    if (allowedNames && !allowedNames.has(name)) continue;

    if (isDuplicate(existingCalls, name, args)) continue;
    if (isDuplicate(scavenged, name, args)) continue;

    scavenged.push({
      id: generateToolCallId(name, args),
      name,
      input: args,
    });
  }

  return [...existingCalls, ...scavenged];
}

export function isScavengeEnabled(config?: { enabled?: boolean }): boolean {
  return config?.enabled !== false;
}
