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

/**
 * 路径可移植化回归 —— 事故驱动（2026-10-07）：
 * 用户在 Termux 跑 hyacinth，bash/read/write 全部 "找不到路径"。
 * 根因：config.json 固化了 os.homedir() 拼出的**平台绝对路径**，跨平台后失效
 * （POSIX 上 `C:\...` 被当**相对路径**，posix.isAbsolute === false）。
 */
describe('ConfigManager 路径可移植化（memoryFile 跨平台）', () => {
  let tempDir: string;
  let manager: ConfigManager;
  const cfgPath = () => path.join(tempDir, '.agent', 'config.json');
  const writeCfg = (obj: unknown) => {
    fs.mkdirSync(path.join(tempDir, '.agent'), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(obj, null, 2), 'utf8');
  };
  /** 本机默认 memoryFile（home 被 mock 成 tempDir，故这里是 tempDir 下的绝对路径） */
  const defaultMemory = () => path.join(tempDir, '.agent', 'prompts', 'persona', 'memory.md');

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `agent-cfg-${crypto.randomUUID()}`);
    mockHomedir.mockReturnValue(tempDir);
    manager = new ConfigManager();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('save：home 下的绝对路径存成 ~ 形式（不把平台路径固化进盘）', async () => {
    await manager.save({ ...(await manager.load()), memoryFile: defaultMemory() });
    const raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    expect(raw.memoryFile).toBe('~/.agent/prompts/persona/memory.md');
    expect(raw.memoryFile).not.toContain(tempDir);
  });

  it('load：~ 形式展开为本机绝对路径', async () => {
    writeCfg({ memoryFile: '~/.agent/prompts/persona/memory.md' });
    const cfg = await manager.load();
    expect(cfg.memoryFile).toBe(defaultMemory());
  });

  /**
   * 「回落默认」的期望值**不是** defaultMemory()：DEFAULT_CONFIG 在**模块加载时**
   * 计算 memoryFile，那一刻 hoisted mock 返回的还是 os.tmpdir()（beforeEach 才把它
   * 改成 tempDir）。故回落值基于 os.tmpdir()。
   */
  const fallbackMemory = () => path.join(os.tmpdir(), '.agent', 'prompts', 'persona', 'memory.md');

  it('load：他平台残留路径被丢弃并回落本机默认（跨平台拷贝 .agent 的兜底）', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      writeCfg({ memoryFile: 'C:\\Users\\someone\\.agent\\prompts\\persona\\memory.md' });
      const cfg = await manager.load();
      expect(cfg.memoryFile).not.toContain('someone');
      expect(cfg.memoryFile).toBe(fallbackMemory());
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('load：本平台绝对路径原样保留（向后兼容旧配置）', async () => {
    const abs = path.join(tempDir, '.agent', 'custom', 'mem.md');
    writeCfg({ memoryFile: abs });
    const cfg = await manager.load();
    expect(cfg.memoryFile).toBe(abs);
  });

  it('load：未设置时用默认（消费点 fallback 仍可用）', async () => {
    writeCfg({ maxTurns: 7 });
    const cfg = await manager.load();
    expect(cfg.memoryFile).toBe(fallbackMemory());
  });
});
