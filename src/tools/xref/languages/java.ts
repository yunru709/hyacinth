import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { resolveJavaLike } from './java-kotlin-shared.js';

export const javaSupport: LanguageSupport = {
  id: 'java',
  extensions: ['.java'],
  extMap: { '.java': 'java' },

  /**
   * 精度链：语法树优先（能给出 caller_name 与 extends/implements 边 —— 基线都给不出），
   * 载不到 wasm 时退正则。降级由构建循环按链依次尝试，files.parser 记成功的那一级。
   */
  async createParsers(): Promise<FileParser[]> {
    const { GenericParser } = await import('../regex-parser.js');
    const { JavaTreeSitterParser } = await import('./java-tree-sitter.js');
    return [new JavaTreeSitterParser(), new GenericParser(['.java'])];
  },

  isIntraProjectSpecifier: () => false, // com.foo.Bar 这类包名不映射到文件，按外部处理
  resolveSpecifier: (spec, _dir, ctx) => resolveJavaLike(spec, ctx.rootDir, 'java'),
};
