/**
 * ProviderConfigLoader 的**磁盘安全**守卫（2026-11-08）。
 *
 * 事故背景：原 `load()` 用一个 `catch {}` 同时兜住「文件不存在」与「JSON 解析失败」，
 * 两者都走 `writeDefault()` ⇒ 用户手写的 `~/.agent/providers.json` **写错一个逗号就被
 * 出厂快照整个覆盖**，且日志只说 "Provider config not found"（误导：文件明明在）。
 * 用户配置丢失不可逆，必须把两种失败彻底分开。
 *
 * 判据：
 *   ① 文件不存在（ENOENT）→ 允许生成默认文件；
 *   ② JSON 解析失败 → **磁盘文件必须字节级不变**，只回退内存快照 + 报 error。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProviderConfigLoader } from './config.js';

const dirs: string[] = [];

function mkTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-provcfg-'));
  dirs.push(dir);
  return path.join(dir, 'providers.json');
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('ProviderConfigLoader：解析失败不得覆盖用户文件', () => {
  it('JSON 语法错误 → 文件字节级不变，回退内存快照', async () => {
    const p = mkTmpPath();
    const broken = '{\n  "providers": {\n    "mine": {\n  }\n}\n'; // 故意缺值
    fs.writeFileSync(p, broken, 'utf-8');

    const loader = new ProviderConfigLoader(process.cwd(), p);
    const cfg = await loader.load();

    // ① 磁盘文件必须原样（这是本修复的核心判据）
    expect(fs.readFileSync(p, 'utf-8')).toBe(broken);
    // ② 内存回退出厂快照，进程不至于起不来
    expect(cfg.providers).toBeDefined();
    expect(Object.keys(cfg.providers).length).toBeGreaterThan(0);
  });

  it('用户声明的厂商在解析失败后**不会**出现在磁盘上（未被覆盖成出厂快照）', async () => {
    const p = mkTmpPath();
    const broken = '{ "providers": { "my-private-gateway": } }';
    fs.writeFileSync(p, broken, 'utf-8');

    await new ProviderConfigLoader(process.cwd(), p).load();

    const after = fs.readFileSync(p, 'utf-8');
    expect(after).toBe(broken);
    // 若被 writeDefault() 覆盖，这里会变成出厂快照（不含用户的 key）
    expect(after).toContain('my-private-gateway');
  });

  it('文件不存在（ENOENT）→ 才允许生成默认文件', async () => {
    const p = mkTmpPath();
    expect(fs.existsSync(p)).toBe(false);

    const cfg = await new ProviderConfigLoader(process.cwd(), p).load();

    expect(fs.existsSync(p)).toBe(true);
    expect(cfg.providers).toBeDefined();
  });

  it('合法 JSON → 正常加载，且不做任何改写', async () => {
    const p = mkTmpPath();
    const good = JSON.stringify(
      { providers: { custom: { id: 'custom', name: 'C', baseUrl: 'https://x', defaultModel: 'm' } } },
      null,
      2,
    );
    fs.writeFileSync(p, good, 'utf-8');

    const cfg = await new ProviderConfigLoader(process.cwd(), p).load();

    expect(cfg.providers.custom?.id).toBe('custom');
    expect(fs.readFileSync(p, 'utf-8')).toBe(good);
  });
});
