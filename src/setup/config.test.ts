/**
 * ConfigManager.saveApiKeyToEnv 测试 — 验证 API key 正确写入全局 .env
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 隔离：mock os.homedir → 临时目录（ConfigManager 的 configDir = ~/.agent）
// 注意：config.ts 用 `import os from 'node:os'`（default 导入），
// 必须同时覆盖命名导出 homedir 和 default 对象，否则 default 仍是真实模块。
const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: vi.fn(() => os.tmpdir()) }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});

import { ConfigManager } from './config.js';

describe('ConfigManager.saveApiKeyToEnv', () => {
  let tempDir: string;
  let manager: ConfigManager;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `agent-cfg-${crypto.randomUUID()}`);
    mockHomedir.mockReturnValue(tempDir);
    manager = new ConfigManager();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('写入指定 envKey 到 .env', async () => {
    await manager.saveApiKeyToEnv('ARK_API_KEY', 'sk-test-123');
    const envPath = path.join(tempDir, '.agent', '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).toContain('ARK_API_KEY=sk-test-123');
    // 同步写入进程环境（供运行期读取）
    expect(process.env.ARK_API_KEY).toBe('sk-test-123');
  });

  it('重复写入同一 envKey 更新旧值', async () => {
    await manager.saveApiKeyToEnv('ARK_API_KEY', 'old-key');
    await manager.saveApiKeyToEnv('ARK_API_KEY', 'new-key');
    const content = fs.readFileSync(path.join(tempDir, '.agent', '.env'), 'utf8');
    expect(content).toContain('ARK_API_KEY=new-key');
    expect(content).not.toContain('old-key');
  });

  it('新增不同 envKey 保留已有行', async () => {
    await manager.saveApiKeyToEnv('ARK_API_KEY', 'a');
    await manager.saveApiKeyToEnv('MINIMAX_API_KEY', 'b');
    const content = fs.readFileSync(path.join(tempDir, '.agent', '.env'), 'utf8');
    expect(content).toContain('ARK_API_KEY=a');
    expect(content).toContain('MINIMAX_API_KEY=b');
  });

  it('saveApiKey 委托：按 provider 映射 envKey 写入', async () => {
    await manager.saveApiKey('deepseek', 'ds-key');
    const content = fs.readFileSync(path.join(tempDir, '.agent', '.env'), 'utf8');
    expect(content).toContain('DEEPSEEK_API_KEY=ds-key');
  });

  it('saveApiKey 未知 provider 静默跳过', async () => {
    await manager.saveApiKey('nonexistent-provider', 'x');
    const envPath = path.join(tempDir, '.agent', '.env');
    expect(fs.existsSync(envPath)).toBe(false);
  });
});
