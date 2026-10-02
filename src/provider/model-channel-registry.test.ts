/**
 * ModelChannelRegistry 持久化语义单测（2026-10-02「切了要记住」语义反转）。
 *
 * 背景：`setChannelModel` 原为"仅内存、不落盘"⇒ 切换重启即丢；同时不写回
 * config ⇒ `listChannels()`（配置视角）与实例（运行视角）对同一次切换给出
 * 矛盾答案。现改为**默认落盘**，本文件守住新契约。
 *
 * 覆盖：
 *  ① 默认落盘：文件可读回，listChannels / getChannelInfo 三处一致
 *  ② persist:false 不落盘：文件不变，resetChannelModel 回到持久化值
 *  ③ upsertChannel 浅合并：只改 thinking 不再抹掉 model / userId
 *  ④ 落盘可往返：新 registry 实例 load 后读到落盘值
 *
 * ⚠️ 隔离：一律经 HYACINTH_MODEL_CHANNELS_PATH 指向临时文件，绝不触碰
 *    ~/.agent/model-channels.json —— 该文件曾被测试夹具值覆盖成真实事故
 *    （见 registry 源码 100-117 行注释）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelChannelRegistry } from './model-channel-registry.js';
import { ProviderManager } from './manager.js';
import { getProviderConfigLoader } from './config.js';

let tmpFile: string;
let prevEnv: string | undefined;

function newRegistry(): ModelChannelRegistry {
  // registry 工厂依赖 ProviderConfigLoader 单例（env key 解析），先初始化
  getProviderConfigLoader(process.cwd());
  const registry = new ModelChannelRegistry();
  registry.buildFromLegacy(undefined, undefined, 'deepseek');
  registry.initializeChannels();
  // 夹具通道：带 key（工厂对空 key 抛错，测试给假 key 走通构造）
  registry.upsertChannel('compression', {
    provider: 'deepseek',
    model: 'old-model',
    apiKey: 'test-key',
    userId: 'hyacinth-compressor',
    thinking: false,
  });
  return registry;
}

function readSaved(): { channels: Record<string, Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
}

beforeEach(() => {
  prevEnv = process.env.HYACINTH_MODEL_CHANNELS_PATH;
  tmpFile = path.join(
    os.tmpdir(),
    `hyacinth-channels-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  process.env.HYACINTH_MODEL_CHANNELS_PATH = tmpFile;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.HYACINTH_MODEL_CHANNELS_PATH;
  else process.env.HYACINTH_MODEL_CHANNELS_PATH = prevEnv;
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe('ModelChannelRegistry 持久化语义', () => {
  it('① setChannelModel 默认落盘：文件可读回，配置视角与实例视角一致', () => {
    const registry = newRegistry();

    registry.setChannelModel('compression', 'deepseek', 'new-model');

    expect(readSaved().channels.compression.model).toBe('new-model');
    expect(registry.listChannels().find((c) => c.name === 'compression')?.model).toBe('new-model');
    expect(registry.getChannelInfo('compression')?.model).toBe('new-model');
  });

  it('② persist:false 不落盘：文件不变，resetChannelModel 回到持久化值', () => {
    const registry = newRegistry();
    const before = fs.readFileSync(tmpFile, 'utf-8');

    registry.setChannelModel('compression', 'deepseek', 'temp-model', { persist: false });

    expect(fs.readFileSync(tmpFile, 'utf-8')).toBe(before);
    expect(registry.getChannelInfo('compression')?.model).toBe('temp-model');

    registry.resetChannelModel('compression');
    expect(registry.getChannelInfo('compression')?.model).toBe('old-model');
  });

  it('③ upsertChannel 浅合并：只改 thinking 不抹掉 model / userId', () => {
    const registry = newRegistry();

    registry.upsertChannel('compression', { thinking: true });

    const saved = readSaved().channels.compression;
    expect(saved.model).toBe('old-model');
    expect(saved.userId).toBe('hyacinth-compressor');
    expect(saved.thinking).toBe(true);
  });

  it('④ 落盘可往返：新 registry 实例 load 后读到落盘值', () => {
    const r1 = newRegistry();
    r1.setChannelModel('compression', 'deepseek', 'persisted-model');

    const r2 = new ModelChannelRegistry();
    r2.load(undefined, 'deepseek');

    expect(r2.listChannels().find((c) => c.name === 'compression')?.model).toBe('persisted-model');
  });
});

/**
 * user-id 隔离的**三级生效值**（2026-10-02 补）。
 *
 * 旧实现是 `{ ...cfg, userId }`：调用方传空 ⇒ **抹掉**通道里配好的 id ⇒
 * 静默掉进 DEFAULT_USER_ID 全局池（与其它"忘配"的调用点互相挤占缓存）。
 * 现契约：**传入值 > 通道配置 > 按 role 派生** —— 任何一级都不退到全局池。
 */
describe('ModelChannelRegistry user-id 生效值', () => {
  it('通道未配 userId ⇒ 建实例时按通道名派生（不再落到全局池）', () => {
    const spy = vi.spyOn(ProviderManager, 'createProviderFromConfig');
    try {
      newRegistry(); // default 通道无 userId
      const derived = spy.mock.calls
        .map((c) => (c[0] as { userId?: string }).userId)
        .filter(Boolean);
      expect(derived).toContain('hyacinth-default');
    } finally {
      spy.mockRestore();
    }
  });

  it('scoped 传空 ⇒ 继承**该角色所属通道**配置的 userId（优先于派生）', () => {
    const registry = newRegistry();
    // 夹具里 buildFromLegacy 把 compression 角色指向 default（那通道没配 userId）
    // ⇒ 显式指回带 userId 的通道，才能测"通道值优先于派生"这一级。
    registry.setRoleMapping('compression', 'compression');
    const spy = vi.spyOn(ProviderManager, 'createProviderFromConfig');
    try {
      registry.createScopedProvider('compression', '');
      const last = spy.mock.calls.at(-1)?.[0] as { userId?: string };
      expect(last.userId).toBe('hyacinth-compressor');
    } finally {
      spy.mockRestore();
    }
  });

  it('scoped 传空 且 通道无值 ⇒ 按 role 派生（仍不退全局池）', () => {
    const spy = vi.spyOn(ProviderManager, 'createProviderFromConfig');
    try {
      const registry = newRegistry();
      registry.createScopedProvider('weird-role', '');
      const last = spy.mock.calls.at(-1)?.[0] as { userId?: string };
      expect(last.userId).toBe('hyacinth-weird-role');
    } finally {
      spy.mockRestore();
    }
  });

  it('scoped 显式传值优先于通道配置', () => {
    const registry = newRegistry();
    const spy = vi.spyOn(ProviderManager, 'createProviderFromConfig');
    try {
      registry.createScopedProvider('compression', 'hyacinth-compressor-sessA');
      const last = spy.mock.calls.at(-1)?.[0] as { userId?: string };
      expect(last.userId).toBe('hyacinth-compressor-sessA');
    } finally {
      spy.mockRestore();
    }
  });
});
