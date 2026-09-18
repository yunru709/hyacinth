/**
 * grammars.test.ts — 语法 wasm 的守卫（设计稿 v2.2 条件 ①/③）
 *
 * 为什么需要：本方案选择"信任官方产物"（不自己构建 wasm）。信任的代价必须用**机制**对冲，
 * 而不是靠一次实验的印象：
 *   ① 清单自证：scripts/grammars.sha256.json 记录的哈希必须与**当前装着的**语法包一致
 *      —— 官方包重发版、node_modules 被换掉，这里立刻红，而不是悄悄换掉运行时解析的语法树。
 *   ③ ABI 进 CI：逐个用 web-tree-sitter 真正 **load** 一遍 —— 运行时与语法产物之间的 ABI
 *      兼容不能只靠"某次实验通过"（设计稿把它列为头号风险，正因它会随版本静默漂移）。
 * 另外：若已构建（dist/grammars/ 存在），顺带校验**入库的那份**与清单一致。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
// 本文件位于 src/tools/xref/languages/ → 上溯四层才是仓库根（清单在 <root>/scripts/）
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MANIFEST = path.join(ROOT, 'scripts', 'grammars.sha256.json');

interface ManifestEntry {
  pkg: string;
  wasm: string;
  bytes: number;
  sha256: string;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Record<string, ManifestEntry>;
const entries = Object.entries(manifest);

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 已装语法包里的 wasm 路径（用包根推导，绕开 exports 限制） */
function installedWasm(pkg: string, wasm: string): string {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), wasm);
}

describe('语法 wasm 清单与 ABI 守卫', () => {
  it('清单非空（空清单 = 守卫静默失效，等同没有守卫）', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('① %s：清单哈希 == 已装语法包的哈希（信任官方产物的对冲）', (lang, e) => {
    const file = installedWasm(e.pkg, e.wasm);
    expect(fs.existsSync(file), `${e.pkg} 里没有 ${e.wasm}（是否已精确锁进 devDependencies？）`).toBe(true);
    expect(sha256(file)).toBe(e.sha256);
    expect(fs.statSync(file).size).toBe(e.bytes);
  });

  it('③ 每个入库 wasm 都能被当前 web-tree-sitter 真正加载（ABI 进 CI，不靠一次实验）', async () => {
    await Parser.init();
    for (const [lang, e] of entries) {
      const file = installedWasm(e.pkg, e.wasm);
      const language = await Language.load(file);
      expect(language, `${lang} 的 wasm 加载失败（ABI 或产物损坏）`).toBeTruthy();
      // 真正用它解析一段代码，确认不是"能 load 但不可用"
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse('x = 1\n');
      // parse() 的类型是 Tree | null（有输入就有树，但类型层面要显式收窄）
      expect(tree, '解析返回了 null').not.toBeNull();
      expect(tree!.rootNode.type).toBeTruthy();
    }
  });

  it('若已构建：dist/grammars/ 里那份与清单逐字节一致（入库产物不打折）', () => {
    const outDir = path.join(ROOT, 'dist', 'grammars');
    if (!fs.existsSync(outDir)) return; // 未构建 → 跳过（构建后由 copy-grammars.cjs 把关）
    for (const [lang, e] of entries) {
      const shipped = path.join(outDir, e.wasm);
      expect(fs.existsSync(shipped), `dist/grammars/${e.wasm} 缺失（构建未跑 copy-grammars？）`).toBe(true);
      expect(sha256(shipped), `${lang} 的入库产物与清单不符`).toBe(e.sha256);
    }
  });
});
