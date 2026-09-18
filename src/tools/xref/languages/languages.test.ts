/**
 * languages.test.ts — 语言注册表的行为快照（Phase 1 半 1 的护栏）
 *
 * 这是**纯重构**，所以测试锁的是"与原内联表逐条一致"，而不是"更正确"：
 * 重构前 manager.ts 的 guessLanguage 里有一张 16 条的内联表，本文件把它**原样**钉住。
 * 若哪天有人（包括我）顺手"修好"了那 5 个语言未知的后缀，本测试会红 —— 那是**行为变更**，
 * 应当先做决定再改断言，而不是悄悄改掉。
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES, allExtensions, languageById, languageOfExtension } from './index.js';

/** 重构前 manager.ts:1769-1776 的内联表，逐条照抄（含缺项 = 语言未知） */
const BEFORE_REFACTOR: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
};

describe('语言注册表（Phase 1）', () => {
  it('后缀 → 语言：与重构前的内联表逐条一致', () => {
    for (const [ext, id] of Object.entries(BEFORE_REFACTOR)) {
      expect(languageOfExtension(ext), `后缀 ${ext}`).toBe(id);
    }
  });

  it('重构前表里没有的后缀，现在也仍然没有映射（行为不为"变好"而改变）', () => {
    // 这 5 个后缀能被解析器解析入库，但 guessLanguage 历来返回 'unknown'
    for (const ext of ['.mjs', '.cjs', '.mts', '.cts', '.pyi', '.pyx']) {
      expect(languageOfExtension(ext), `后缀 ${ext} 应无映射（既有现状）`).toBeNull();
    }
    expect(languageOfExtension('.zzz')).toBeNull();
  });

  it('大小写不敏感（guessLanguage 的调用方已归一，但注册表自身也该稳）', () => {
    expect(languageOfExtension('.TS')).toBe('typescript');
    expect(languageOfExtension('.Go')).toBe('go');
  });

  it('每个描述符的 extMap 键都在自己的 extensions 之内（不许映射到一个不扫描的后缀）', () => {
    for (const lang of LANGUAGES) {
      for (const ext of Object.keys(lang.extMap)) {
        expect(lang.extensions, `${lang.id} 的 ${ext}`).toContain(ext);
      }
    }
  });

  it('allExtensions 与 parsers 的扫描范围一致（8 门语言的并集）', () => {
    const exts = allExtensions();
    for (const ext of ['.ts', '.tsx', '.js', '.py', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.swift']) {
      expect(exts).toContain(ext);
    }
    expect(new Set(exts).size).toBe(exts.length); // 去重
  });

  it('按 id 取描述符', () => {
    expect(languageById('ccpp')?.extMap['.cpp']).toBe('cpp');
    expect(languageById('python')?.id).toBe('python');
    expect(languageById('nope')).toBeUndefined();
  });
});
