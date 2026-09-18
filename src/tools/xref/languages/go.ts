import type { FileParser } from '../parser.js';
import type { LanguageSupport } from './types.js';
import { firstFileInDir } from './resolve-helpers.js';

export const goSupport: LanguageSupport = {
  id: 'go',
  extensions: ['.go'],
  extMap: { '.go': 'go' },

  /**
   * 精度链：语法树优先（能给出 caller_name 与嵌入边 —— generic-regex 都给不出），
   * 载不到 wasm 时退正则。降级由构建循环按链依次尝试，files.parser 记成功的那一级。
   */
  async createParsers(): Promise<FileParser[]> {
    const { GenericParser } = await import('../regex-parser.js');
    const { GoTreeSitterParser } = await import('./go-tree-sitter.js');
    return [new GoTreeSitterParser(), new GenericParser(['.go'])];
  },

  // Go 的项目内形态就是 `./pkg`（相对），已由通用规则覆盖
  isIntraProjectSpecifier: () => false,

  /**
   * Go：模块路径 → 仓库内目录（搬自 manager.ts，逐字保留）。
   * 优先按 go.mod 的 module 名剥前缀，其次直接按仓库根拼接；
   * 命中目录后取该目录下字典序第一个 .go 文件作代表（Go 是「目录=包」，
   * 依赖图本质上按目录理解更贴切，这里落成文件行以便复用文件级 BFS）。
   *
   * 注：go.mod 的探测与缓存仍在 manager（项目级状态），通过 ctx 注入。
   */
  async resolveSpecifier(spec, _dir, ctx): Promise<string | null> {
    const root = ctx.rootDir;
    const mods = await ctx.goModules();
    const dirCandidates: string[] = [];
    for (const mod of mods) {
      if (spec === mod.name || spec.startsWith(mod.name + '/')) {
        const rel = spec.slice(mod.name.length).replace(/^\//, '');
        dirCandidates.push(rel === '' ? mod.dir : `${mod.dir}/${rel}`);
      }
    }
    // 兜底：仓库根下按路径直接找（无 go.mod 或非模块化仓库）
    dirCandidates.push(`${root}/${spec}`);
    for (const dirCandidate of dirCandidates) {
      const picked = await firstFileInDir(dirCandidate, '.go');
      if (picked) return picked;
    }
    return null;
  },
};
