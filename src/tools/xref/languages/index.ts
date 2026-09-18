/**
 * 语言注册表 —— 「哪个后缀属于哪门语言」的唯一落点（Phase 1 半 1）。
 *
 * 组装方式：**显式枚举**（组合根），不扫目录、不自动发现 ——
 * 与项目「注册而非硬编码」的主线一致，也让"加一门语言动了什么"一眼可见。
 *
 * 覆盖 8 个描述符：typescript（含 js 家族）、python、go、rust、ccpp、java、kotlin、swift。
 * 与重构前的内联表逐条一致（见 languages.test.ts 的快照回归）。
 */
import type { LanguageSupport } from './types.js';

export const LANGUAGES: readonly LanguageSupport[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    // .mjs/.cjs/.mts/.cts 可解析但无 language 映射 —— 现状（见 types.ts 注记）
    extMap: { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript' },
  },
  {
    id: 'python',
    extensions: ['.py', '.pyi', '.pyx'],
    extMap: { '.py': 'python' }, // .pyi/.pyx 同上：可解析、语言未知
  },
  { id: 'go', extensions: ['.go'], extMap: { '.go': 'go' } },
  { id: 'rust', extensions: ['.rs'], extMap: { '.rs': 'rust' } },
  {
    id: 'ccpp',
    extensions: ['.c', '.h', '.cpp', '.hpp'],
    extMap: { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp' },
  },
  { id: 'java', extensions: ['.java'], extMap: { '.java': 'java' } },
  { id: 'kotlin', extensions: ['.kt'], extMap: { '.kt': 'kotlin' } },
  { id: 'swift', extensions: ['.swift'], extMap: { '.swift': 'swift' } },
];

// 建索引时顺带做一条不变量：同一后缀不得被两个描述符声明（模块加载即检查，零成本）
const BY_EXT = new Map<string, string>();
for (const lang of LANGUAGES) {
  for (const [ext, id] of Object.entries(lang.extMap)) {
    const prev = BY_EXT.get(ext);
    if (prev !== undefined) {
      throw new Error(`语言注册表冲突：后缀 ${ext} 同时被 ${prev} 与 ${lang.id} 声明`);
    }
    BY_EXT.set(ext, id);
  }
}

/** 后缀 → language id；无映射返回 null（调用方决定兜底值，当前为 'unknown'） */
export function languageOfExtension(ext: string): string | null {
  return BY_EXT.get(ext.toLowerCase()) ?? null;
}

/** 全部可扫描后缀（去重） */
export function allExtensions(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.extensions))];
}

/** 按 id 取描述符 */
export function languageById(id: string): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
