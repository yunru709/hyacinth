/**
 * startup-resolution 单测 —— 「启动用哪家 provider」的真源契约。
 *
 * 2026-10-02：`provider.active` 退役，启动解析改读 `model-channels.json` 的 chat 通道。
 * 本文件守住三条：
 *   ① chat 通道（含 roles.chat 映射）是唯一来源；
 *   ② 缺失/损坏一律退化为 `none`（交给既有默认链路，启动不该被坏文件拖垮）；
 *   ③ **完全不读 config.json 的 provider.active**（哪怕它就摆在同一目录里）。
 *
 * ⚠️ 隔离：全部在 mkdtemp 临时目录内构造，绝不触碰 ~/.agent 真配置。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStartupProvider } from './startup-resolution.js';

let dir: string;
let channelsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-startup-'));
  channelsFile = path.join(dir, 'model-channels.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveStartupProvider', () => {
  it('chat 通道存在 → 用它（厂商 + 模型）', () => {
    fs.writeFileSync(
      channelsFile,
      JSON.stringify({
        channels: { chat: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } },
        roles: { chat: 'chat' },
      }),
      'utf-8',
    );
    expect(resolveStartupProvider(channelsFile)).toEqual({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      source: 'chat-channel',
    });
  });

  it('roles.chat 指向别的通道名 → 跟随映射（不写死 chat）', () => {
    fs.writeFileSync(
      channelsFile,
      JSON.stringify({
        channels: { main: { provider: 'deepseek', model: 'deepseek-flash' } },
        roles: { chat: 'main' },
      }),
      'utf-8',
    );
    const r = resolveStartupProvider(channelsFile);
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-flash');
  });

  it('文件不存在 / JSON 损坏 / 无 chat 通道 → none', () => {
    expect(resolveStartupProvider(channelsFile).source).toBe('none');

    fs.writeFileSync(channelsFile, '{ broken', 'utf-8');
    expect(resolveStartupProvider(channelsFile).source).toBe('none');

    fs.writeFileSync(
      channelsFile,
      JSON.stringify({ channels: { other: { provider: 'deepseek' } } }),
      'utf-8',
    );
    expect(resolveStartupProvider(channelsFile).source).toBe('none');
  });

  it('通道存在但缺 provider 字段 → none（不返回半截结果）', () => {
    fs.writeFileSync(channelsFile, JSON.stringify({ channels: { chat: { model: 'm' } } }), 'utf-8');
    expect(resolveStartupProvider(channelsFile).source).toBe('none');
  });

  it('不读同目录的 config.json 的 provider.active（字段已退役）', () => {
    // 摆一个"会误导"的 config.json：解析结果不得受其影响
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ provider: { active: 'openai' } }),
      'utf-8',
    );
    fs.writeFileSync(
      channelsFile,
      JSON.stringify({
        channels: { chat: { provider: 'commandcode', model: 'm' } },
        roles: { chat: 'chat' },
      }),
      'utf-8',
    );
    expect(resolveStartupProvider(channelsFile).provider).toBe('commandcode');
  });
});
