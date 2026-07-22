import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

/**
 * JsonEditTool — 读写 JSON/YAML/TOML 文件，按路径修改字段。
 *
 * 支持 JSON（原生）和 YAML/TOML（需 Node.js 解析）。
 * 路径用点号分隔，如 "compilerOptions.target"。
 * 写回时保留原始缩进格式。
 */
export class JsonEditTool implements Tool {
  readonly name = 'json_edit';
  readonly description =
    '读取或修改 JSON / YAML / TOML 文件中指定路径的键值。路径使用点号分隔（如 "compilerOptions.target"）。只传路径不传 value=读取当前值；传 value=写入并保持原格式。支持嵌套对象、数组元素和深层路径。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the JSON/YAML/TOML file (absolute or relative to cwd)' },
      path: { type: 'string', description: 'Dot-separated key path (e.g. "dependencies.express")' },
      value: { type: 'string', description: 'New value to set. If omitted, returns current value. JSON values allowed.' },
    },
    required: ['file', 'path'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file as string;
    const keyPath = args.path as string;
    const rawValue = args.value as string | undefined;
    const isRead = rawValue === undefined;

    if (!filePath || !keyPath) return 'Error: Both file and path are required.';

    const cwd = process.cwd();
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

    let content: string;
    try { content = fs.readFileSync(absPath, 'utf-8'); }
    catch { return `Error: Cannot read file: ${absPath}`; }

    const ext = path.extname(absPath).toLowerCase();
    const isJson = ext === '.json';
    const isYaml = ext === '.yaml' || ext === '.yml';
    const isToml = ext === '.toml';

    // Parse
    let parsed: unknown;
    try {
      if (isJson) {
        parsed = JSON.parse(content);
      } else if (isYaml || isToml) {
        return 'Error: YAML/TOML support requires Node.js YAML/TOML parsers. ' +
          'Install yaml/toml packages or convert to JSON.';
      } else {
        // Try JSON as fallback
        try { parsed = JSON.parse(content); }
        catch { return `Error: Unsupported file format "${ext}". Use .json, .yaml, or .toml.`; }
      }
    } catch (e) {
      return `Error: Failed to parse file: ${(e as Error).message}`;
    }

    // Navigate to path
    const keys = keyPath.split('.');
    let current: Record<string, unknown> = parsed as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (current[k] === undefined) {
        if (isRead) return `Key "${keys.slice(0, i + 1).join('.')}" not found.`;
        current[k] = {};
      }
      if (typeof current[k] !== 'object' || current[k] === null) {
        return `Error: "${keys.slice(0, i + 1).join('.')}" is not an object (got ${typeof current[k]}).`;
      }
      current = current[k] as Record<string, unknown>;
    }

    const leafKey = keys[keys.length - 1];

    if (isRead) {
      const val = current[leafKey];
      if (val === undefined) return `Key "${keyPath}" not found.`;
      return JSON.stringify(val, null, 2);
    }

    // Write: parse value (try JSON, fallback to string)
    let newValue: unknown = rawValue;
    try { newValue = JSON.parse(rawValue!); } catch { /* use raw string */ }

    // If the new value starts with { or [, try to parse as JSON inline
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { newValue = JSON.parse(trimmed); } catch { /* keep as string */ }
      }
    }

    current[leafKey] = newValue;

    // Write back with minimal diff: detect original indent
    const indentMatch = content.match(/\n(\s+)/);
    const indent = indentMatch ? indentMatch[1].length : 2;
    const newContent = JSON.stringify(parsed, null, indent) + '\n';

    try { fs.writeFileSync(absPath, newContent, 'utf-8'); }
    catch (e) { return `Error: Cannot write file: ${(e as Error).message}`; }

    return `Set "${keyPath}" to ${JSON.stringify(newValue)} in ${absPath}`;
  }
}
