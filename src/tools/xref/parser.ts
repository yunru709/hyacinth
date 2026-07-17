/**
 * 文件解析器接口与注册中心。
 *
 * 每种语言可以有多个解析器（按优先级排序）：
 *   - TsParser: TypeScript/JavaScript AST 解析（调用 ts.createSourceFile）
 *   - TsRegexParser: 当 TS compiler 不可用时的正则回退
 *   - PyParser: Python 正则解析
 *   - GenericParser: 通用括号匹配回退
 */

import path from 'node:path';
import type { ParsedFile } from './schema.js';

export interface FileParser {
  /** 解析器名称（用于日志） */
  readonly name: string;
  /** 支持的文件扩展名 */
  readonly extensions: string[];
  /** 解析单个文件 */
  parseFile(filePath: string): Promise<ParsedFile>;
}

/**
 * ParserRegistry — 按文件扩展名选择最佳解析器。
 */
export class ParserRegistry {
  private parsers: FileParser[] = [];

  register(parser: FileParser): void {
    this.parsers.push(parser);
  }

  /** 获取适合该文件的解析器（按注册顺序，优先返回第一个匹配） */
  getParser(filePath: string): FileParser | null {
    const ext = path.extname(filePath).toLowerCase();
    for (const parser of this.parsers) {
      if (parser.extensions.includes(ext)) return parser;
    }
    return null;
  }

  /** 获取所有已注册的扩展名 */
  getAllExtensions(): string[] {
    return [...new Set(this.parsers.flatMap(p => p.extensions))];
  }
}

/**
 * 创建默认的解析器注册中心（尝试加载 TS parser，失败则使用正则回退）。
 */
export async function createParserRegistry(): Promise<ParserRegistry> {
  const registry = new ParserRegistry();

  // 尝试加载 TypeScript AST 解析器
  try {
    const { TsParser } = await import('./ts-parser.js');
    registry.register(new TsParser());
  } catch {
    // TypeScript 不可用，使用正则回退
    try {
      const { TsRegexParser } = await import('./regex-parser.js');
      registry.register(new TsRegexParser());
    } catch {
      // 忽略
    }
  }

  // 正则回退解析器（总是可用）
  try {
    const { PyParser, GenericParser } = await import('./regex-parser.js');
    registry.register(new PyParser());
    registry.register(new GenericParser());
  } catch {
    // 忽略
  }

  return registry;
}
