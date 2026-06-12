import type { Tool } from '../interface.js';
import { executePython } from './executor.js';
import { parsePythonToolMeta, type PythonToolMeta } from './parser.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('python-bridge');

/**
 * PythonToolBridge — 将 Python 脚本桥接为 Tool 接口。
 *
 * 解析阶段（tool-watcher 触发）:
 *   → parsePythonToolMeta(filePath) → PythonToolMeta
 *   → new PythonToolBridge(filePath, meta)
 *   → ToolRegistry.register(bridge)
 *
 * 执行阶段（Agent 调用时）:
 *   → bridge.execute(args) → executePython(filePath, args) → 返回 stdout
 */
export class PythonToolBridge implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  private filePath: string;

  constructor(filePath: string, meta: PythonToolMeta) {
    this.filePath = filePath;
    this.name = meta.name;
    this.description = meta.description;
    this.inputSchema = meta.inputSchema;
  }

  /** 工厂：从文件路径创建 Bridge（含解析） */
  static fromFile(filePath: string): PythonToolBridge | null {
    const meta = parsePythonToolMeta(filePath);
    if (!meta) return null;
    return new PythonToolBridge(filePath, meta);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    logger.debug(`Executing Python tool: ${this.name} (${this.filePath})`);
    return executePython(this.filePath, args);
  }
}
