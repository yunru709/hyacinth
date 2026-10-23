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
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

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
});
