import path from 'node:path';
import type { LanguageSupport } from './types.js';
import { firstExisting, normPath } from './resolve-helpers.js';

export const rustSupport: LanguageSupport = {
  id: 'rust',
  extensions: ['.rs'],
  extMap: { '.rs': 'rust' },
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
