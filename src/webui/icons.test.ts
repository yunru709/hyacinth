/**
 * icons.test.ts — lucide 子集与源码是否同步（src/webui/vendor/lucide-subset.js）
 *
 * 背景：index.html 原先挂的是官方全量包（1939 个图标 / 388KB），本项目只用 78 个。
 * 现在由 `scripts/gen-icons.cjs` 从全量包里裁出子集，首屏少下 370KB。
 *
 * 这条测试拦的是**最容易犯且最难发现**的错误：
 *   新加了一个 `data-lucide="xxx"` 但忘了跑 `pnpm gen:icons`。
 *   此时页面上那个图标**静默空白**——不报错、不警告，肉眼很容易漏掉。
 *
 * 做法是跑生成器的 `--check` 模式（只比对、不写盘），它内部还会重新执行产物、
 * 逐个比对图标数据是否与全量包一致（防止外科手术改坏数据）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/** 与 lucide 的命名约定一致：kebab-case → PascalCase（createIcons 就是这么查表的） */
function pascal(name: string): string {
  return name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/** 在隔离上下文里执行子集 UMD，拿到它真正注册了哪些图标 */
function loadSubsetIcons(): Record<string, unknown> {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'webui', 'vendor', 'lucide-subset.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  new Function('globalThis', 'self', 'window', 'module', 'exports', 'define', src)(
    sandbox, sandbox, sandbox, undefined, undefined, undefined,
  );
  const lucide = sandbox.lucide as { icons?: Record<string, unknown> } | undefined;
  return lucide?.icons ?? {};
}

describe('lucide 子集', () => {
  it('与源码里的 data-lucide 使用点保持同步（漏跑 pnpm gen:icons 会在这里失败）', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-icons.cjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      // 生成器只读文件 + 比对，不写盘；NODE_OPTIONS 里若挂了 fs shim 也不影响读项目文件
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(out).toContain('已同步');
  }, 30000);

  /**
   * pvIconFor 按扩展名 `return 'folder' / 'file-code' / …`，不是 `data-lucide="…"`
   * 字面量，生成器的正则扫不到它们。曾经因此漏掉 folder / file / file-code：
   * 文件树里目录行和代码文件行**静默没有图标**（不报错），靠看截图才发现。
   *
   * 这条守卫把"pvIconFor 可能返回的名字"当作使用点，任何一个不在子集里就失败 ——
   * 以后新增文件类型映射也跑不掉。
   */
  it('pvIconFor 的返回值都在子集里（否则对应行静默无图标）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'webui', 'app.js'), 'utf8');
    const start = src.indexOf('function pvIconFor(');
    expect(start).toBeGreaterThan(-1);
    // 函数体到下一个顶层 function 为止（缩进一致，够稳）
    const body = src.slice(start, src.indexOf('\n  function ', start + 10));
    const names = [...body.matchAll(/return\s+'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(3);

    const icons = loadSubsetIcons();
    const missing = names.filter((n) => !icons[pascal(n)]);
    expect(missing).toEqual([]);
  });
});
