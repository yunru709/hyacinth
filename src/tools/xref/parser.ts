/**
 * 文件解析器接口与注册中心。
 *
 * 每种语言可以有多个解析器（按优先级排序）：
 *   - TsParser: TypeScript/JavaScript AST 解析（调用 ts.createSourceFile）
 *   - TsRegexParser: 当 TS compiler 不可用时的正则回退
 *   - PyParser: Python 正则解析
 *   - GenericParser: 通用括号匹配回退
 *
 * Phase 1 之后：**谁提供哪些解析器**由 languages/ 注册表声明（一门语言一个描述符），
 * 本文件只负责按声明顺序装配 ParserRegistry。加一门语言不再需要改这里。
 */
import path from 'node:path';
import type { ParsedFile } from './schema.js';
import { LANGUAGES } from './languages/index.js';

export interface FileParser {
  /** 解析器名称（用于日志与 files.parser 列） */
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

  /**
   * 获取适合该文件的**解析器链**（按注册顺序 = 精度优先级）。
   *
   * 为什么要链而不是单个：一门语言可以声明"先试高精度、失败退低精度"
   *（如 python 先 py-tree-sitter 再 py-regex）。构建循环按序尝试，并把**成功者**的
   * name 记进 `files.parser` —— 这样"降级确实发生过"是可查的事实，而不是靠外层名字
   * 假装没降级。
   */
  getParsers(filePath: string): FileParser[] {
    const ext = path.extname(filePath).toLowerCase();
    return this.parsers.filter((p) => p.extensions.includes(ext));
  }

  /** 兼容入口：链首（不关心降级时够用） */
  getParser(filePath: string): FileParser | null {
    return this.getParsers(filePath)[0] ?? null;
  }

  /** 获取所有已注册的扩展名 */
  getAllExtensions(): string[] {
    return [...new Set(this.parsers.flatMap(p => p.extensions))];
  }
}

/**
 * 创建默认的解析器注册中心 —— 遍历语言注册表，按**声明顺序**注册。
 *
 * 顺序即优先级：getParser 返回首个匹配，故 typescript 必须排在其余语言之前
 * （保证 .ts 走 AST 而非正则兜底）。降级链由各描述符的 createParsers 自行声明
 * （如 TS AST 装不上则退正则），注册表不感知。
 */
export async function createParserRegistry(): Promise<ParserRegistry> {
  const registry = new ParserRegistry();
  for (const lang of LANGUAGES) {
    for (const parser of await lang.createParsers()) {
      registry.register(parser);
    }
  }
  return registry;
}
