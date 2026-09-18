/**
 * tree-sitter-loader.ts — 语法 wasm 的加载（各语言解析器共用）
 *
 * 从 python-tree-sitter.ts 抽出的纯重构（行为逐条不变）：一门语言的语法加载包含两件事 ——
 *   ① 找 wasm：优先随包分发的 dist/grammars/，开发/测试期退回 node_modules；
 *   ② 加载并缓存（**只缓存成功**：这样"刚跑过构建、dist/grammars 才就位"时无需重启即可用）。
 *
 * 为什么共用而不是各语言复制一份：这段是**引擎**（与语言无关），多语言共用能让
 * "找 wasm / 缓存策略 / 失败语义"三件事只有一个实现 —— 各语言之间不再有漂移空间。
 * 各语言各自的**知识**（节点类型、导入形态、结构性边）仍在各自的提取器里。
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface GrammarSpec {
  /** 语法包名（须已精确锁进 devDependencies，并由 scripts/copy-grammars.cjs 校验哈希） */
  pkg: string;
  /** 包内 wasm 文件名，如 'tree-sitter-go.wasm' */
  wasm: string;
}

/** wasm 候选路径：① dist/grammars/（运行时该走这条）② node_modules（开发/测试） */
function wasmCandidates(spec: GrammarSpec): string[] {
  const out: string[] = [];
  out.push(path.resolve(HERE, '..', '..', '..', 'grammars', spec.wasm));
  try {
    const pkgJson = require.resolve(`${spec.pkg}/package.json`);
    out.push(path.join(path.dirname(pkgJson), spec.wasm));
  } catch {
    // 语法包未安装（可选路径）——忽略
  }
  return out;
}

const cache = new Map<string, Promise<Language>>();

/**
 * 载入某语言的语法（进程内只成功加载一次）。
 * **失败不缓存** —— 刚跑过构建（dist/grammars 才就位）的情况下无需重启即可用。
 * 返回 null 表示两处都载不到：调用方应抛错，交由精度链降级（且出处会如实记录）。
 */
export async function loadGrammar(spec: GrammarSpec): Promise<Language | null> {
  const key = spec.pkg;
  const hit = cache.get(key);
  if (hit) return hit;

  const attempt = (async (): Promise<Language | null> => {
    await Parser.init();
    for (const p of wasmCandidates(spec)) {
      try {
        if (!fsSync.existsSync(p)) continue;
        return await Language.load(p);
      } catch {
        // ABI 不符或产物损坏 → 试下一个候选（守卫测试 grammars.test.ts 会单独抓这类问题）
      }
    }
    return null;
  })();

  const lang = await attempt;
  if (lang) cache.set(key, Promise.resolve(lang));
  return lang;
}
