import path from 'node:path';
import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { firstExisting, normPath } from './resolve-helpers.js';

export const pythonSupport: LanguageSupport = {
  id: 'python',
  extensions: ['.py', '.pyi', '.pyx'],
  extMap: { '.py': 'python' }, // .pyi/.pyx 同上：可解析、语言未知

  async createParsers(): Promise<FileParser[]> {
    const { PyParser } = await import('../regex-parser.js');
    return [new PyParser()];
  },

  isIntraProjectSpecifier: () => false,

  /**
   * Python 说明符解析（搬自 manager.ts，本体重逐字保留）。
   * 旧实现把 `from .pkg import x` 的 `.pkg` 当相对路径拼接，去找 `<dir>/.pkg.py`
   * （带前导点的文件名），必然不命中；同时非相对导入完全不采集 ⇒ Python 依赖图此前整体为空。
   *
   * 现在按 PEP 328：前导点数是上跳层数（1 个点 = 当前包目录，2 个 = 上一级），
   * 其余按点拆成目录，兼容 `x.py` 与包目录 `x/__init__.py`；
   * 非相对说明符按项目根解析（解析不到即视作标准库/第三方，不计入缺失）。
   */
  async resolveSpecifier(spec, dir, ctx): Promise<string | null> {
    const root = ctx.rootDir;
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots);
    let baseDir = dir;
    for (let i = 1; i < dots; i++) baseDir = normPath(path.dirname(baseDir));

    const candidates: string[] = [];
    if (rest === '') {
      candidates.push(`${baseDir}/__init__.py`, `${baseDir}/__init__.pyi`);
    } else {
      const rel = rest.split('.').filter(Boolean).join('/');
      candidates.push(`${baseDir}/${rel}.py`, `${baseDir}/${rel}.pyi`, `${baseDir}/${rel}/__init__.py`);
    }
    if (dots === 0) {
      const rel = spec.split('.').filter(Boolean).join('/');
      candidates.push(`${root}/${rel}.py`, `${root}/${rel}/__init__.py`);
    }
    return firstExisting([...new Set(candidates)]);
  },
};
