import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { resolveTsLike } from './resolve-helpers.js';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export const typescriptSupport: LanguageSupport = {
  id: 'typescript',
  extensions: TS_EXTS,
  // .mjs/.cjs/.mts/.cts 可解析但无 language 映射 —— 现状（见 types.ts 注记）
  extMap: { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript' },

  /** 与重构前的工厂逐字一致：优先 TypeScript AST，装不上才退回正则（降级可查） */
  async createParsers(): Promise<FileParser[]> {
    try {
      const { TsParser } = await import('../ts-parser.js');
      return [new TsParser()];
    } catch {
      // TypeScript 不可用（它自 v? 起是 optionalDependency，装不上不该阻断索引）
      const { TsRegexParser } = await import('../regex-parser.js');
      return [new TsRegexParser()];
    }
  },

  isIntraProjectSpecifier: () => false, // 相对路径由调用方统一处理，本语言无额外形态

  // 非相对说明符一律视为外部依赖（原 switch 的 ts/javascript 分支即此语义）
  async resolveSpecifier(spec, dir): Promise<string | null> {
    return spec.startsWith('.') ? resolveTsLike(spec, dir) : null;
  },
};
