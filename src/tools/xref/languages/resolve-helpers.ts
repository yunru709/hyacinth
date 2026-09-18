/**
 * 说明符解析的共享探针（Phase 1 半 2b）。
 *
 * 为什么成文件：这几个函数是**解析引擎**（被多门语言复用），不是"某门语言的知识"——
 * 后者才该出现在各描述符里。
 *
 * normPath 是**有意重复** manager.ts 的同名函数（2 行）：描述符不得反向依赖 manager
 * （会形成循环依赖）。两处共同遵守的约定：库里所有 path 一律存「正斜杠绝对路径」。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 路径单一规范：正斜杠绝对路径（语义与 manager.ts 的同名函数相同，有意重复） */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 依次尝试候选路径，返回首个存在的文件 */
export async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isFile()) return normPath(c);
    } catch {
      // 不存在，试下一个
    }
  }
  return null;
}

/** 目录下第一个指定扩展名的文件（字典序，保证多次构建结果稳定） */
export async function firstFileInDir(dirCandidate: string, ext: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dirCandidate, { withFileTypes: true });
    const hit = entries
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => e.name)
      .sort()[0];
    return hit ? normPath(`${dirCandidate}/${hit}`) : null;
  } catch {
    return null;
  }
}

/**
 * TS/JS 相对说明符解析 —— 本次最关键的一处修复（原在 manager.ts）。
 *
 * 旧实现只做「往路径尾部拼扩展名」，于是 `from './manager.js'` 会去找
 * `manager.js.ts` / `manager.js.js`，两条都不可能存在 ⇒ 永远 null。
 * 而 NodeNext / bundler 的通行约定是：说明符写 `./x.js`，源码实际是 `./x.ts`。
 * 本项目 2617 条相对导入全是这种写法，所以 imports 表恒为 0，
 * deps / dependents / impact / symbol_search / 文件依赖图全部空转。
 *
 * 现在按 Node 的解析顺序试：
 *   1) 原路径本身
 *   2) 去掉 .js/.mjs/.cjs/.jsx 后换 TS 扩展名（.js→.ts/.tsx，.mjs→.mts，.cjs→.cts）
 *   3) 原路径 + 各扩展名
 *   4) 当作目录 → <dir>/index.<ext>
 *
 * 位置说明：它是**共用引擎**（typescript 描述符、swift 描述符、以及未注册语言的 default
 * 分支都要用它），故不放在 typescript.ts 里。
 */
export async function resolveTsLike(spec: string, dir: string): Promise<string | null> {
  const base = normPath(path.resolve(dir, spec));
  const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
  const ALL_EXTS = [...TS_EXTS, '.js', '.jsx', '.mjs', '.cjs'];
  const candidates: string[] = [base];

  const esmSuffix = base.match(/\.(js|mjs|cjs|jsx)$/);
  if (esmSuffix) {
    const stem = base.slice(0, -esmSuffix[0].length);
    const mapped: string[] =
      esmSuffix[0] === '.mjs' ? ['.mts']
      : esmSuffix[0] === '.cjs' ? ['.cts']
      : esmSuffix[0] === '.jsx' ? ['.tsx', '.jsx']
      : ['.ts', '.tsx'];
    for (const e of mapped) candidates.push(stem + e);
  }

  for (const e of ALL_EXTS) candidates.push(base + e);
  for (const e of ALL_EXTS) candidates.push(`${base}/index${e}`);

  return firstExisting([...new Set(candidates)]);
}
