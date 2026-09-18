import type { LanguageSupport } from './types.js';
import { resolveTsLike } from './resolve-helpers.js';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export const typescriptSupport: LanguageSupport = {
  id: 'typescript',
  extensions: TS_EXTS,
  // .mjs/.cjs/.mts/.cts 可解析但无 language 映射 —— 现状（见 types.ts 注记）
  extMap: { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript' },
  isIntraProjectSpecifier: () => false, // 相对路径由调用方统一处理，本语言无额外形态

  // 非相对说明符一律视为外部依赖（原 switch 的 ts/javascript 分支即此语义）
  async resolveSpecifier(spec, dir): Promise<string | null> {
    return spec.startsWith('.') ? resolveTsLike(spec, dir) : null;
  },
};
