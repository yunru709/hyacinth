/**
 * ClawBot 插件注册 / 渠道启动语义的回归守卫。
 *
 * 背景（本测试要钉死的 bug）：
 *   插件 autoRegister 早先写成「enabled === false 直接 return」，渠道不进注册表，
 *   而 TUI 的 `/clawbot/login` 分派依赖 channelManager.get('clawbot') → 一律报
 *   Unknown sub-command。偏偏登录命令就是「从零授权」的入口（渠道自身注释：
 *   "无 token → 等待用户通过 /clawbot login 触发"），于是鸡生蛋死结：
 *   不先启用就登不进去，可登录本身又不需要事先启用。
 *
 * 现在的不变式：
 *   ① 无论 enabled 真假，渠道**始终注册**（且以 enabled:true 纳入生命周期管理）；
 *   ② 用户配置的 enabled 经 `autoConnect` 传达给渠道 —— false 时只备好授权通道，
 *      不恢复 token、不连接、不轮询；
 *   ③ 未启用时不注入 channelsInfo（避免 System Prompt 宣称微信可用）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 hoisted 定义 spy，供 vi.mock 工厂与断言共享（vi.mock 会被提升到文件顶部）
const h = vi.hoisted(() => ({
  restoreFromCache: vi.fn(async () => false),
  setTokenDirect: vi.fn(),
  startAuthorization: vi.fn(async () => false),
}));

vi.mock('./clawbot-auth.js', () => {
  class ClawbotAuthManager {
    token: string | null = null;
    hasValidToken = false;
    botIdentifier = '';
    userIdentifier = '';
    restoreFromCache = h.restoreFromCache;
    setTokenDirect = h.setTokenDirect;
    startAuthorization = h.startAuthorization;
    checkAndWarn = () => {};
    constructor(_baseUrl: string, _timeout: number, _cb: unknown) {}
  }
  return { ClawbotAuthManager };
});

const { clawbotChannelPlugin } = await import('./index.js');
const { createClawbotChannel } = await import('./index.js');

function setupPlugin() {
  const registered: Array<{ handler: { id: string }; config: Record<string, unknown> }> = [];
  const channelManager = {
    register: vi.fn((handler: { id: string }, config: Record<string, unknown>) => {
      registered.push({ handler, config });
    }),
  };
  const channelsInfo: unknown[] = [];
  return { channelManager, channelsInfo, registered };
}

describe('clawbotChannelPlugin.autoRegister', () => {
  it('enabled:false **仍然注册渠道**（否则 /clawbot/login 报 Unknown sub-command）', async () => {
    const { channelManager, channelsInfo, registered } = setupPlugin();

    await clawbotChannelPlugin.autoRegister(
      channelManager as never,
      { enabled: false },
      channelsInfo as never,
    );

    expect(channelManager.register).toHaveBeenCalledTimes(1);
    expect(registered[0]!.handler.id).toBe('clawbot');
    // 纳入生命周期管理（始终启动）—— 注意这不是用户配置里的那个 enabled
    expect(registered[0]!.config.enabled).toBe(true);
    // 但不连接：用户配置的 enabled 直通渠道
    expect(registered[0]!.config.autoConnect).toBe(false);
  });

  it('enabled:false 时不注入 channelsInfo（避免 System Prompt 宣称微信可用）', async () => {
    const { channelManager, channelsInfo } = setupPlugin();

    await clawbotChannelPlugin.autoRegister(
      channelManager as never,
      { enabled: false },
      channelsInfo as never,
    );

    expect(channelsInfo).toHaveLength(0);
  });

  it('enabled:true → autoConnect:true 且注入 channelsInfo', async () => {
    const { channelManager, channelsInfo, registered } = setupPlugin();

    await clawbotChannelPlugin.autoRegister(
      channelManager as never,
      { enabled: true },
      channelsInfo as never,
    );

    expect(registered[0]!.config.autoConnect).toBe(true);
    expect(channelsInfo).toHaveLength(1);
    expect((channelsInfo[0] as { name: string }).name).toBe('clawbot');
  });

  it('配置缺省（无 channels.clawbot 段）→ 视为启用', async () => {
    const { channelManager, channelsInfo, registered } = setupPlugin();

    await clawbotChannelPlugin.autoRegister(channelManager as never, undefined, channelsInfo as never);

    expect(registered[0]!.config.autoConnect).toBe(true);
    expect(channelsInfo).toHaveLength(1);
  });
});

describe('ClawbotChannel.start 的 autoConnect 语义', () => {
  beforeEach(() => {
    h.restoreFromCache.mockClear();
    h.setTokenDirect.mockClear();
  });

  it('autoConnect:false → 建好授权管理器但不恢复 token、不连接', async () => {
    const ch = createClawbotChannel();

    await ch.start({ autoConnect: false, botToken: 'should-be-ignored' } as never);

    // 关键：早退发生在 restoreFromCache / setTokenDirect 之前
    expect(h.restoreFromCache).not.toHaveBeenCalled();
    expect(h.setTokenDirect).not.toHaveBeenCalled();
    // 渠道状态为「已就绪但未连接」（与「无 token」分支同语义）
    expect(ch.getStatus()).toBe('active');
  });

  it('autoConnect 缺省（true）→ 走正常流程（会尝试恢复 token）', async () => {
    const ch = createClawbotChannel();

    await ch.start({ botToken: '' } as never);

    expect(h.restoreFromCache).toHaveBeenCalledTimes(1);
    expect(ch.getStatus()).toBe('active');
  });
});
