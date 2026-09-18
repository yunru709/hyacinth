/**
 * 语言注册表 —— 一门语言的声明式事实的唯一落点（Phase 1）。
 *
 * 组装方式：**显式枚举**（组合根），不扫目录、不自动发现 ——
 * 与项目「注册而非硬编码」的主线一致，也让"加一门语言动了什么"一眼可见。
 *
 * 覆盖 8 个描述符：typescript（含 js 家族）、python、go、rust、ccpp、java、kotlin、swift。
 * 与重构前的散落实现逐条对应（见 languages.test.ts 的快照回归）。
 */
import type { LanguageSupport } from './types.js';

export const LANGUAGES: readonly LanguageSupport[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    // .mjs/.cjs/.mts/.cts 可解析但无 language 映射 —— 现状（见 types.ts 注记）
    extMap: { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript' },
    isIntraProjectSpecifier: () => false, // 相对路径由调用方统一处理，本语言无额外形态
  },
  {
    id: 'python',
    extensions: ['.py', '.pyi', '.pyx'],
    extMap: { '.py': 'python' }, // .pyi/.pyx 同上：可解析、语言未知
    isIntraProjectSpecifier: () => false,
  },
  {
    id: 'go',
    extensions: ['.go'],
    extMap: { '.go': 'go' },
    // Go 的项目内形态就是 `./pkg`（相对），已由通用规则覆盖
    isIntraProjectSpecifier: () => false,
  },
  {
    id: 'rust',
    extensions: ['.rs'],
    extMap: { '.rs': 'rust' },
    // crate/super/self:: 开头与 mod: 前缀：Rust 的模块路径不是文件路径，但确属项目内
    isIntraProjectSpecifier: (spec) => /^(crate|self|super)::/.test(spec) || spec.startsWith('mod:'),
  },
  {
    id: 'ccpp',
    extensions: ['.c', '.h', '.cpp', '.hpp'],
    extMap: { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp' },
    // 只采集引号形式（#include "x.h"）—— 尖括号形式是系统头文件，采集侧就不收，
    // 故到达这里的一律是项目内（原实现的注释即此意）
    isIntraProjectSpecifier: () => true,
  },
  {
    id: 'java',
    extensions: ['.java'],
    extMap: { '.java': 'java' },
    isIntraProjectSpecifier: () => false, // com.foo.Bar 这类包名不映射到文件，按外部处理
  },
  {
    id: 'kotlin',
    extensions: ['.kt'],
    extMap: { '.kt': 'kotlin' },
    isIntraProjectSpecifier: () => false,
  },
  {
    id: 'swift',
    extensions: ['.swift'],
    extMap: { '.swift': 'swift' },
    isIntraProjectSpecifier: () => false,
  },
];

// 建索引时顺带做两条不变量（模块加载即检查，零成本）
const BY_EXT = new Map<string, string>();
const BY_LANG_ID = new Map<string, LanguageSupport>();
for (const lang of LANGUAGES) {
  for (const [ext, id] of Object.entries(lang.extMap)) {
    const prev = BY_EXT.get(ext);
    if (prev !== undefined) {
      throw new Error(`语言注册表冲突：后缀 ${ext} 同时被 ${prev} 与 ${lang.id} 声明`);
    }
    BY_EXT.set(ext, id);
    if (!BY_LANG_ID.has(id)) BY_LANG_ID.set(id, lang);
  }
}

/** 后缀 → language id；无映射返回 null（调用方决定兜底值，当前为 'unknown'） */
export function languageOfExtension(ext: string): string | null {
  return BY_EXT.get(ext.toLowerCase()) ?? null;
}

/**
 * language id（写入 files.language 的取值，如 'c' / 'javascript'）→ 其所属描述符。
 * 为什么不按描述符 id 查：两者**不是一回事** —— ccpp 描述符产出 'c' 与 'cpp' 两个 id，
 * typescript 描述符产出 'typescript' 与 'javascript'。调用方拿到的永远是 language id。
 */
export function supportForLanguage(id: string): LanguageSupport | undefined {
  return BY_LANG_ID.get(id);
}

/** 全部可扫描后缀（去重） */
export function allExtensions(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.extensions))];
}

/** 按描述符 id 取描述符 */
export function languageById(id: string): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
