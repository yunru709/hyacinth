/**
 * doctor 的 API Key 检查守卫（2026-11-08 修复）。
 *
 * 事故：原实现硬编码 6 个 env 名（真源 PROVIDER_META 有 16 个），且 doctor 子命令
 * **从不调用 loadEnvKeys** —— 只查 `process.env`，对"把 key 写在 ~/.agent/.env 里"
 * 的用户（常态用法）恒为误报；兜底还去查 `config.provider.apiKey`（这个字段不存在）。
 *
 * ⚠️ 本函数读真实 `~/.agent/.env`（无 env 隔离点），因此测试只做**正向断言**：
 * 只要 `process.env` 里有某个真源 key，就必须判定为已配置；且输出绝不能含密钥值。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { checkApiKeys } from './doctor.js';

const touched: string[] = [];

function setEnv(k: string, v: string): void {
  process.env[k] = v;
  touched.push(k);
}

afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

describe('checkApiKeys：真源覆盖', () => {
  it('非"六大厂"的 key（ARK_API_KEY）也必须被识别（原实现漏掉）', () => {
    setEnv('ARK_API_KEY', 'ark-fake-value-for-test');

    const r = checkApiKeys();

    expect(r.ok).toBe(true);
    // 只显示变量名前缀，且必须真的出现了 ARK
    expect(r.detail).toContain('ARK');
  });

  it('OPENCODE_API_KEY 同样在真源内（原实现漏掉）', () => {
    setEnv('OPENCODE_API_KEY', 'oc_sk_fake_value_for_test');

    const r = checkApiKeys();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('OPENCODE');
  });

  it('输出绝不能包含密钥值（只允许变量名前缀）', () => {
    setEnv('COMMANDCODE_API_KEY', 'super-secret-commandcode-value');

    const r = checkApiKeys();

    expect(r.detail).not.toContain('super-secret-commandcode-value');
    // 变量名本身可以出现（去掉 _API_KEY 后缀后的形式）
    expect(r.detail).toContain('COMMANDCODE');
  });
});
