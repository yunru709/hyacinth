import path from 'node:path';
import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { firstExisting, normPath } from './resolve-helpers.js';

export const rustSupport: LanguageSupport = {
  id: 'rust',
  extensions: ['.rs'],
  extMap: { '.rs': 'rust' },

  /**
   * 精度链：语法树优先（能给出 caller_name 与 impl 结构性边 —— generic-regex 都给不出），
   * 载不到 wasm 时退正则。降级由构建循环按链依次尝试，files.parser 记成功的那一级。
   */
  async createParsers(): Promise<FileParser[]> {
    const { GenericParser } = await import('../regex-parser.js');
    const { RustTreeSitterParser } = await import('./rust-tree-sitter.js');
    return [new RustTreeSitterParser(), new GenericParser(['.rs'])];
  },

  // crate/super/self:: 开头与 mod: 前缀：Rust 的模块路径不是文件路径，但确属项目内
  isIntraProjectSpecifier: (spec) => /^(crate|self|super)::/.test(spec) || spec.startsWith('mod:'),

  /** Rust：mod 声明 / crate:: / self:: / super:: 说明符（外部 crate 返回 null）。逐字搬自 manager.ts */
  async resolveSpecifier(spec, dir, ctx): Promise<string | null> {
    const root = ctx.rootDir;
    let baseDir = dir;
    let rest = spec;
    let isModDecl = false;
    if (spec.startsWith('crate::')) {
      baseDir = `${root}/src`;
      rest = spec.slice('crate::'.length);
    } else if (spec.startsWith('self::')) {
      rest = spec.slice('self::'.length);
    } else if (spec.startsWith('super::')) {
      baseDir = normPath(path.dirname(dir));
      rest = spec.slice('super::'.length);
    } else if (spec.startsWith('mod:')) {
      isModDecl = true;
      rest = spec.slice('mod:'.length);
    } else if (!spec.startsWith('.')) {
      return null;
    }

    const segs = rest.split('::').filter(Boolean);
    if (isModDecl) {
      const name = segs[0] ?? rest;
      return firstExisting([`${baseDir}/${name}.rs`, `${baseDir}/${name}/mod.rs`]);
    }
    // use a::b::Thing → 逐级回退：a/b.rs / a/b/mod.rs → a.rs / a/mod.rs
    for (let n = segs.length; n >= 1; n--) {
      const rel = segs.slice(0, n).join('/');
      const hit = await firstExisting([`${baseDir}/${rel}.rs`, `${baseDir}/${rel}/mod.rs`]);
      if (hit) return hit;
    }
    return null;
  },
};
