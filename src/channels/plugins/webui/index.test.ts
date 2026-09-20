/**
 * webui 渠道插件的行为测试（2026-09-20）。
 *
 * 守的是什么：新增"网页版跟着我一起起来"这条路之后，
 * ① **默认不开** ✓ —— 配置里没有 `enabled: true` 时不许注册（对现有用户"一个字不变" ✓）
 * ② 开了才注册，并且注册的是 `http-webhook` 那个渠道 ✓
 * ③ **幂等** ✓ —— 已被 `serve` / `webui` 路径注册过时不重复注册 ✓（否则同 id 冲突 ✗）
 *
 * 为什么不用真 ChannelManager：本测试只关心"注册/不注册"这个判断 ✓，
 * 用最小替身即可（且不会起监听 ⇒ 无端口抖动 ✗）。
 */
import { describe, it, expect } from 'vitest';
import { webuiChannelPlugin } from './index.js';

function fakeManager() {
  const items = new Map<string, unknown>();
  return {
    get: (id: string) => items.get(id),
    register: (handler: { id: string }) => { items.set(handler.id, handler); },
  };
}

describe('webui 渠道插件（让网页版跟着我一起起来 ✓）', () => {
  it('默认不开：配置里没有 enabled:true ⇒ 不注册（现有行为不变 ✓）', async () => {
    const m = fakeManager();
    const info: unknown[] = [];

    await webuiChannelPlugin.autoRegister(m as never, {}, info as never);

    expect(info.length, '不该往渠道清单里宣告 ✓').toBe(0);
    expect(m.get('http-webhook'), '不该注册渠道 ✓').toBeUndefined();
  });

  it('enabled:true ⇒ 注册 http-webhook 渠道 + 宣告渠道信息 ✓', async () => {
    const m = fakeManager();
    const info: unknown[] = [];

    await webuiChannelPlugin.autoRegister(
      m as never,
      { enabled: true, port: 3100, host: '0.0.0.0', noAuth: true },
      info as never,
    );

    expect(m.get('http-webhook'), '应注册成 http-webhook 渠道 ✓').toBeDefined();
    expect(info.length, '应宣告一条渠道信息 ✓').toBe(1);
  });

  it('幂等：已被 serve/webui 路径注册过 ⇒ 不重复注册 ✓', async () => {
    const m = fakeManager();
    const info: unknown[] = [];
    m.register({ id: 'http-webhook' }); // 模拟 serve 路径先注册 ✓

    await webuiChannelPlugin.autoRegister(m as never, { enabled: true }, info as never);

    expect(info.length, '已存在 ⇒ 不该再宣告 ✓').toBe(0);
  });

  it('configKey 必须是 webui（对应配置里的 channels.webui ✓）', () => {
    expect(webuiChannelPlugin.configKey).toBe('webui');
  });
});
