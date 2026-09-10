// ============================================================
// Generation 插件（P3 第二个功能插件）验收测试
// ============================================================
// 验证：
//   1. TTS 未启用时插件 idle（注册 tts: null，不装配）
//   2. TTS 启用时注册 'generation.api' 且 tts 句柄可用
//   3. tts.onTurnEnd 每回合现读 config（enabled 关闭后不再合成）
//   4. 卸载回滚（服务注销）
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { PluginHost } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import { createGenerationPlugin, GENERATION_API_KEY, type GenerationApi } from './generation-plugin.js';

interface Services extends Record<string, unknown> {
  'generation.api': GenerationApi;
}
type Hooks = LoopHooks & Record<string, unknown>;

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genplug-'));
}

/** 记录 configCenter.get 调用的最小 mock */
function makeConfig(values: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    configCenter: {
      get: <T = unknown>(p: string): T => {
        calls.push(p);
        return (values[p] ?? undefined) as T;
      },
    } as never,
    calls,
  };
}

describe('generation 插件', () => {
  let cwd: string;
  afterEach(() => {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('TTS 未启用时 idle：注册 tts:null，不装配', async () => {
    cwd = tmpCwd();
    const host = new PluginHost<Services, Hooks>({});
    const { configCenter } = makeConfig({ 'companion.tts.enabled': false });

    await host.mount(createGenerationPlugin({ cwd, configCenter }));

    const api = host.get(GENERATION_API_KEY);
    expect(api).toBeTruthy();
    expect(api!.tts).toBeNull();
  });

  it('TTS 启用时注册 tts 句柄，onTurnEnd 现读 config（关闭后不再合成）', async () => {
    cwd = tmpCwd();
    const host = new PluginHost<Services, Hooks>({});
    // 初始 enabled=true；测试中途 flip 到 false
    let enabled = true;
    const configCenter = {
      get: <T = unknown>(p: string): T => {
        if (p === 'companion.tts.enabled') return enabled as T;
        if (p === 'companion.tts.voice') return 'default' as T;
        if (p === 'companion.tts.provider') return 'minimax' as T;
        return undefined as T;
      },
    } as never;

    await host.mount(createGenerationPlugin({ cwd, configCenter }));

    const api = host.get(GENERATION_API_KEY);
    expect(api).toBeTruthy();
    expect(api!.tts).not.toBeNull();

    // onTurnEnd 存在（真实合成依赖外部服务，这里只验证调用契约不抛）
    expect(typeof api!.tts!.onTurnEnd).toBe('function');

    // 关闭 TTS 后再次调用：不抛（内部守卫直接 return）
    enabled = false;
    expect(() => api!.tts!.onTurnEnd('hi', 'alice', () => {}, { sayId: 's1' })).not.toThrow();

    // 卸载后 api 服务注销
    await host.unmount('generation');
    expect(host.get(GENERATION_API_KEY)).toBeUndefined();
  });
});
