/**
 * 守卫：装配期**不得**用运行时状态覆盖磁盘上的通道配置（2026-10-02）。
 *
 * 起因：`setMainProvider` 旧实现会把主对话的类型写回 `config.channels[default].provider`，
 * 且**不碰 `model`** ⇒ 把用户配的「甲厂商 + 乙家的模型名」改成「主对话类型 + 乙家模型名」
 * ⇒ 厂商与模型不匹配，调用必失败（实测：本机 default 被写成 `deepseek` + 一个
 * 带 `deepseek/…` 前缀的 commandcode 模型 id，自检直接报错）。
 *
 * 原则（写进 docs/design/config-code-separation.md §3）：**磁盘是权威**，
 * 装配/运行时只影响内存实例；要改配置必须走显式 API（upsertChannel / setChannelModel）。
 *
 * ⚠️ 隔离：经 HYACINTH_MODEL_CHANNELS_PATH 指向临时文件，绝不触碰 ~/.agent 真配置。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelChannelRegistry } from './model-channel-registry.js';
import { getProviderConfigLoader } from './config.js';
import type { Provider } from './interface.js';

let tmpDir: string;
let tmpFile: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-nooverwrite-'));
  tmpFile = path.join(tmpDir, 'model-channels.json');
  prevEnv = process.env.HYACINTH_MODEL_CHANNELS_PATH;
  process.env.HYACINTH_MODEL_CHANNELS_PATH = tmpFile;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.HYACINTH_MODEL_CHANNELS_PATH;
  else process.env.HYACINTH_MODEL_CHANNELS_PATH = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeProvider(type = 'deepseek'): Provider {
  return {
    getProviderType: () => type,
    getModel: () => 'm',
    getCapabilities: () => ({ isLocal: false }),
  } as unknown as Provider;
}

describe('装配期不覆盖通道配置', () => {
  it('setMainProvider 不改写 default 通道的 provider/model（磁盘值保持）', () => {
    getProviderConfigLoader(process.cwd());
    const registry = new ModelChannelRegistry();
    registry.load(undefined, 'deepseek');
    // 用户显式配置：甲厂商 + 甲家的模型名
    registry.upsertChannel('default', {
      provider: 'commandcode',
      model: 'stealth/pixel-canary',
      apiKey: 'test-key',
    });
    expect(registry.listChannels().find((c) => c.name === 'default')?.provider).toBe('commandcode');

    // 运行时注入主对话 Provider（类型与配置里配的不同源）—— 这正是事故现场
    registry.setMainProvider(fakeProvider('deepseek'), 'deepseek');

    const after = registry.listChannels().find((c) => c.name === 'default');
    expect(after?.provider).toBe('commandcode'); // ← 不得被覆盖
    expect(after?.model).toBe('stealth/pixel-canary'); // ← 不得被清掉
  });

  it('setMainProvider 仍会注入内存实例（配置不动、运行生效）', () => {
    getProviderConfigLoader(process.cwd());
    const registry = new ModelChannelRegistry();
    registry.load(undefined, 'deepseek');
    const injected = fakeProvider('commandcode');
    registry.setMainProvider(injected, 'commandcode');
    expect(registry.getChannelProvider('default')).toBe(injected);
  });
});
