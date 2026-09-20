/**
 * WebUI 渠道插件（2026-09-20）—— 让网页版像微信一样"**跟着我一起起来**" ✓
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────
 * `HttpWebhookChannel` **本来就是个正规渠道** ✓（有 id、有 start(config)、能被 manager 注册），
 * 但此前**只有 `serve` / `webui` 那条命令**会注册它 ✗ ⇒ 于是"终端里的我"与"网页版的我"**互斥** ✗。
 * 用户判定这是方向错了 ✓：网页版该是**我的一件器官**，不是另一条得手敲的命令 ✓。
 *
 * ── 做法（照 clawbot 的同一模板 ✓）──────────────────────────────────
 * 声明配置键 `webui` ✓；在 `autoRegister` 里把渠道登记进 ChannelManager ✓；
 * 之后由 `channelManager.startAll()` **统一启动** ✓ —— TUI 路径本来就会调 `registerConfigChannels` ✓，
 * 所以配好之后**只跑 `hyacinth tui`，网页版就同时就绪** ✓（平板可直接开 ✓）。
 *
 * ── 两条硬约束 ──────────────────────────────────────────────────────
 * · **默认不开** ✓：`enabled !== true` ⇒ 直接返回 ⇒ 对任何现有用户"一个字都不变" ✓。
 * · **幂等** ✓：若该渠道已被注册（例如 `serve` / `webui` 那条路径先注册了）⇒ 跳过，绝不重复注册 ✓。
 */
import type { ChannelPlugin } from '../auto-detect.js';
import { HttpWebhookChannel, WEBUI_SESSION_PREFIXES, isLoopbackHost } from './http-webhook.js';
import { registerChannelPrefixes } from '../../session-channel.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('webui-plugin');

/** `channels.webui` 的配置形状（与 setup/config.ts 里的声明一致 ✓） */
export interface WebUiChannelConfigEntry {
  /** 是否随我一起启动（**默认 false** ✓ —— 不开就与从前完全一致 ✓） */
  enabled?: boolean;
  /** 监听端口（默认 3100 ✓） */
  port?: number;
  /** 监听地址（默认 127.0.0.1 = 只对本机 ✓；'0.0.0.0' = 对外开放 ✓） */
  host?: string;
  /** 早期测试：不校验钥匙 ✓（对外开放时通道会**大声警告** ✓） */
  noAuth?: boolean;
  /** 访问钥匙（对外开放建议配 ✓；也可用环境变量 HYACINTH_API_KEY ✓） */
  apiKey?: string;
}

/**
 * 解析 WebUI 静态资源目录（与 cli.ts 同款策略 ✓）：源码树优先，其次 dist 产物 ✓。
 * 从**本模块自身位置**推导 ⇒ 全局安装、任意 cwd 都成立 ✓。
 */
function resolveWebuiRoot(): string | undefined {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(dir, '../../../src/webui');
    const distRoot = path.resolve(dir, '../../webui');
    if (existsSync(srcRoot)) return srcRoot;
    if (existsSync(distRoot)) return distRoot;
  } catch { /* 取不到就让通道用默认 ✓ */ }
  return undefined;
}

export const webuiChannelPlugin: ChannelPlugin = {
  configKey: 'webui',

  async autoRegister(channelManager, config, channelsInfo) {
    // session 前缀登记：**与 enabled 无关** ✓（存量 `webui_xxx` 会话要能反解出渠道归属 ✓，同 clawbot 的做法 ✓）
    registerChannelPrefixes(WEBUI_SESSION_PREFIXES, 'webui');

    const cfg = (config ?? {}) as WebUiChannelConfigEntry;
    if (cfg.enabled !== true) return; // 默认不开 ⇒ 现有行为不变 ✓

    // 幂等：serve / webui 那条路径可能已经注册过同一个渠道 ✓
    if (channelManager.get('http-webhook')) {
      logger.info('webui 渠道已由 serve/webui 路径注册 ⇒ 跳过（不重复注册 ✓）');
      return;
    }

    const host = cfg.host ?? '127.0.0.1';
    const port = cfg.port ?? 3100;

    channelManager.register(new HttpWebhookChannel(), {
      port,
      host,
      noAuth: cfg.noAuth === true,
      apiKey: cfg.apiKey,
      webuiRoot: resolveWebuiRoot(),
      enabled: true,
    });

    if (!isLoopbackHost(host)) {
      logger.warn(`webui 渠道已按配置对外开放（监听 ${host}:${port}）—— 同一局域网内的设备可访问 ✓`);
    }

    channelsInfo.push({
      name: 'webui',
      displayName: 'WebUI（浏览器 / 平板）',
      connectionMode: 'http+ws',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      requireMention: false,
    });
  },
};

/** 插件自动发现约定的导出名（与 clawbot 一致 ✓） */
export { webuiChannelPlugin as channelPlugin };
