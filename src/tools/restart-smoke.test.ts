import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { smokeTestEntry } from './restart.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-smoke-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('restart 构建冒烟（--version）', () => {
  it('入口正常输出版本 → ok', async () => {
    const dir = tmp();
    const entry = path.join(dir, 'ok.cjs');
    fs.writeFileSync(entry, "process.stdout.write('1.2.3\\n');\n", 'utf8');

    const result = await smokeTestEntry(entry, dir, 10_000);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('1.2.3');
  });

  it('入口非零退出 → 失败并带退出码', async () => {
    const dir = tmp();
    const entry = path.join(dir, 'fail.cjs');
    fs.writeFileSync(entry, "process.stderr.write('boom'); process.exit(2);\n", 'utf8');

    const result = await smokeTestEntry(entry, dir, 10_000);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('exit 2');
    expect(result.detail).toContain('boom');
  });

  it('入口不存在 → 失败（不会误放行）', async () => {
    const result = await smokeTestEntry(path.join(tmp(), 'missing.js'), tmp(), 1000);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });
});
