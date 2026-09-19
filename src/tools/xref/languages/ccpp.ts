import path from 'node:path';
import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { firstExisting } from './resolve-helpers.js';

export const ccppSupport: LanguageSupport = {
  id: 'ccpp',
  extensions: ['.c', '.h', '.cpp', '.hpp'],
  extMap: { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp' },

  /**
   * 精度链：语法树优先（一份实现按后缀选 tree-sitter-c / tree-sitter-cpp；能给出 caller_name
   * 与 C++ 的继承边 —— 基线都给不出），载不到 wasm 时退正则。
   */
  async createParsers(): Promise<FileParser[]> {
    const { GenericParser } = await import('../regex-parser.js');
    const { CCppTreeSitterParser } = await import('./ccpp-tree-sitter.js');
    return [new CCppTreeSitterParser(), new GenericParser(['.c', '.h', '.cpp', '.hpp'])];
  },

  // 只采集引号形式（#include "x.h"）—— 尖括号形式是系统头文件，采集侧就不收，
  // 故到达这里的一律是项目内（原实现的注释即此意）
  isIntraProjectSpecifier: () => true,

  /** C/C++：#include "x.h" —— 先同目录，再 include/，最后仓库根。逐字搬自 manager.ts */
  async resolveSpecifier(spec, dir, ctx): Promise<string | null> {
    const root = ctx.rootDir;
    const exts = path.extname(spec) ? [''] : ['.h', '.hpp', '.hxx'];
    const candidates: string[] = [];
    for (const base of [dir, `${root}/include`, root]) {
      for (const e of exts) candidates.push(`${base}/${spec}${e}`);
    }
    return firstExisting(candidates);
  },
};
