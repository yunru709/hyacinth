/**
 * 语言注册表 —— 一门语言的声明式事实的唯一落点（Phase 1）。
 *
 * 组装方式：**显式枚举**（组合根），不扫目录、不自动发现 ——
 * 与项目「注册而非硬编码」的主线一致，也让"加一门语言动了什么"一眼可见。
 *
 * 覆盖 8 个描述符：typescript（含 js 家族）、python、go、rust、ccpp、java、kotlin、swift。
 * 实现分别在各自的文件里（一语言一文件）；本文件只做装配与查询。
 */
import type { LanguageSupport } from './types.js';
import { typescriptSupport } from './typescript.js';
import { pythonSupport } from './python.js';
import { goSupport } from './go.js';
import { rustSupport } from './rust.js';
import { ccppSupport } from './ccpp.js';
import { javaSupport } from './java.js';
import { kotlinSupport } from './kotlin.js';
import { swiftSupport } from './swift.js';

export const LANGUAGES: readonly LanguageSupport[] = [
  typescriptSupport,
  pythonSupport,
  goSupport,
  rustSupport,
  ccppSupport,
  javaSupport,
  kotlinSupport,
  swiftSupport,
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
