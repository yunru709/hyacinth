import { readFileSync } from 'node:fs';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('python-parser');

export interface PythonToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 从 Python 文件的 docstring 中解析工具元信息。
 *
 * 支持格式:
 *   """
 *   name: my_tool
 *   description: 工具描述
 *   parameters:
 *     type: object
 *     properties:
 *       arg1: {type: string, description: 参数1}
 *     required: [arg1]
 *   """
 */
export function parsePythonToolMeta(filePath: string): PythonToolMeta | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    logger.warn(`Failed to read Python tool: ${filePath}`);
    return null;
  }

  const docstring = extractDocstring(content);
  if (!docstring) {
    logger.debug(`No docstring found in ${filePath}`);
    return null;
  }

  try {
    const meta = parseYamlLike(docstring);
    if (!meta.name || !meta.description) {
      logger.warn(`Python tool ${filePath} missing required 'name' or 'description' in docstring`);
      return null;
    }
    return meta;
  } catch (err) {
    logger.warn(`Failed to parse docstring in ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

/** 提取第一个 triple-quoted docstring */
function extractDocstring(content: string): string | null {
  // 匹配 """...""" 或 '''...'''
  const m = content.match(/"""([^"]*)"""/s) ?? content.match(/'''([^']*)'''/s);
  return m ? m[1].trim() : null;
}

/** 简单 YAML-like 解析：缩进层级 + 键值对 + 大括号块 */
function parseYamlLike(text: string): PythonToolMeta {
  const result: PythonToolMeta = { name: '', description: '', inputSchema: { type: 'object', properties: {} } };
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (key === 'name') {
      result.name = rest;
      i++;
    } else if (key === 'description') {
      let desc = rest;
      // 多行描述：后续以同缩进或更深缩进开头的非键值行
      const baseIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextIndent = nextLine.match(/^(\s*)/)?.[1].length ?? 0;
        const nextColon = nextLine.indexOf(':');
        // 如果下一行缩进更深且不是新的键值对，追加到描述
        if (nextIndent > baseIndent && (nextColon === -1 || nextIndent >= nextLine.indexOf(':')!)) {
          desc += '\n' + nextLine.trimStart();
          i++;
        } else {
          break;
        }
      }
      result.description = desc;
    } else if (key === 'parameters') {
      // 找 parameters 块：收集从下一行开始直到缩进回归的所有行
      const blockLines: string[] = [];
      const baseIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextIndent = nextLine.match(/^(\s*)/)?.[1].length ?? 0;
        if (nextIndent <= baseIndent && nextLine.trim()) break;  // 缩进回归，参数块结束
        blockLines.push(nextLine);
        i++;
      }
      const schemaText = blockLines.join('\n').trim();
      if (schemaText) {
        try {
          result.inputSchema = parseJsonLike(schemaText);
        } catch {
          // 解析失败，保留默认 schema
          logger.warn('Failed to parse parameters block, using default schema');
        }
      }
    } else {
      i++;
    }
  }

  return result;
}

/** 将缩进 YAML-like 的 parameters 块转为 JSON Schema 对象 */
function parseJsonLike(text: string): Record<string, unknown> {
  // Step 1: 将缩进格式转为 JSON 字符串
  const lines = text.split('\n');
  const jsonLines = convertToJsonLines(lines);
  try {
    return JSON.parse(jsonLines);
  } catch {
    // 嵌套花括号可能被分割, 尝试手动构建
  }
  return { type: 'object', properties: {} };
}

function convertToJsonLines(lines: string[]): string {
  const parts: string[] = [];
  let i = 0;
  const indentStack: number[] = [];
  // 标记：下一个 item 是否需要前导逗号
  let needsComma = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // 关闭更深的块
    while (indentStack.length > 0 && indent <= indentStack[indentStack.length - 1]) {
      parts.push('}');
      indentStack.pop();
      needsComma = true; // 块关闭后，下一个同层 item 需要逗号
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    // 去掉尾部的逗号（支持 YAML-like trailing comma）
    if (val.endsWith(',')) val = val.slice(0, -1);

    if (val === '{') {
      // 开始一个新的嵌套对象
      const keyQuoted = /^\w+$/.test(key) ? `"${key}"` : key;
      parts.push(`${needsComma ? ', ' : ''}${keyQuoted}: {`);
      indentStack.push(indent);
      needsComma = false; // 刚打开的块内部不需要逗号
    } else if (!val || (val.startsWith('{') && !val.endsWith('}'))) {
      // 空值或残缺的内联对象 → 检查下一行是否有更深缩进
      const hasDeeperBlock =
        i + 1 < lines.length &&
        (lines[i + 1].match(/^(\s*)/)?.[1].length ?? 0) > indent;
      if (hasDeeperBlock) {
        const keyQuoted = /^\w+$/.test(key) ? `"${key}"` : key;
        parts.push(`${needsComma ? ', ' : ''}${keyQuoted}: {`);
        indentStack.push(indent);
        needsComma = false;
      } else {
        const keyQuoted = /^\w+$/.test(key) ? `"${key}"` : key;
        parts.push(`${needsComma ? ', ' : ''}${keyQuoted}: ${formatJsonValue(val)}`);
        needsComma = true;
      }
    } else if (val.startsWith('{') && val.endsWith('}')) {
      // 单行对象: key: { ... }
      const keyQuoted = /^\w+$/.test(key) ? `"${key}"` : key;
      parts.push(`${needsComma ? ', ' : ''}${keyQuoted}: ${formatJsonValue(val)}`);
      needsComma = true;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      // 数组值
      const keyQuoted = /^\w+$/.test(key) ? `"${key}"` : key;
      const arrItems = val.slice(1, -1).split(',').map(s => s.trim()).map(s => /^\w+$/.test(s) ? `"${s}"` : s).join(', ');
      parts.push(`${needsComma ? ', ' : ''}${keyQuoted}: [${arrItems}]`);
      needsComma = true;
    } else {
      // 普通键值对
      const keyQuoted = /^\w+$/.test(key) ? `"${key}"` : key;
      parts.push(`${needsComma ? ', ' : ''}${keyQuoted}: ${formatJsonValue(val)}`);
      needsComma = true;
    }
    i++;
  }

  // 关闭所有未闭合的块
  while (indentStack.length > 0) {
    parts.push('}');
    indentStack.pop();
  }

  return `{${parts.join('')}}`;
}

function formatJsonValue(val: string): string {
  if (val === 'true' || val === 'false') return val;
  if (val === 'null') return 'null';
  if (/^-?\d+(\.\d+)?$/.test(val)) return val;
  // 内联 YAML-like 对象: {key: val, key2: val2}
  if (val.startsWith('{') && val.endsWith('}')) {
    const obj = parseInlineYamlObject(val);
    if (obj) return JSON.stringify(obj);
  }
  // 字符串：引号包裹，转义内部引号
  const escaped = val.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** 将内联 YAML-like 对象 {key: val, key: val} 解析为真正的 JS 对象 */
function parseInlineYamlObject(text: string): Record<string, unknown> | null {
  try {
    const inner = text.slice(1, -1).trim();
    if (!inner) return {};
    const result: Record<string, unknown> = {};
    // 按逗号分割，但只在逗号后紧跟 "单词:" 模式时才算真正的分隔
    const segments = inner.split(/,\s*(?=\w+\s*:)/);
    for (const seg of segments) {
      const colonIdx = seg.indexOf(':');
      if (colonIdx === -1) continue;
      const key = seg.slice(0, colonIdx).trim();
      const val = seg.slice(colonIdx + 1).trim();
      result[key] = val;
    }
    return result;
  } catch {
    return null;
  }
}
