// ============================================================
// auto-detect.ts — 渠道自动检测（插件注册表模式）
// ============================================================
//
// 职责：
//   根据 config.json 自动检测并注册配置驱动渠道
//   通过 ChannelPlugin 注册表实现可扩展的渠道自动注册
//   TUI 渠道始终默认允许，由调用方手动注册和启动
//   HTTP 渠道由 serve 模式负责
//
// 使用方式：
//   import { registerConfigChannels, registerChannelPlugin } from './channels/auto-detect.js';
//   registerChannelPlugin(feishuChannelPlugin);
//   const channelsInfo = await registerConfigChannels(channelManager, cwd);
//   await channelManager.startAll(messageProcessor);
// ============================================================

import type { ChannelManager } from './manager.js';
import { ConfigManager } from '../setup/config.js';
import type { ChannelsInfo } from '../env/index.js';

// ─── ChannelPlugin 接口 ─────────────────────────────────────────

export interface ChannelPlugin {
  /** 配置 key 名（对应 config.json 中 channels 下的键名） */
  configKey: string;
  /** 自动注册渠道 */
  autoRegister(
    channelManager: ChannelManager,
    config: unknown,
    channelsInfo: ChannelsInfo[],
  ): Promise<void>;
  /** Gateway 启动时执行全局设置（如日志拦截），返回清理函数 */
  onGatewayInit?(): (() => void) | void;
}

// ─── 插件注册表 ─────────────────────────────────────────────────

const channelPlugins: ChannelPlugin[] = [];

export function registerChannelPlugin(plugin: ChannelPlugin): void {
  channelPlugins.push(plugin);
}

export function getChannelPlugins(): ChannelPlugin[] {
  return [...channelPlugins];
}

// ─── 自动注册入口 ───────────────────────────────────────────────

/**
 * 自动发现渠道插件。
 * 扫描 channels/plugins 下的子目录中导出的 channelPlugin 常量。
 */
export async function discoverPlugins(): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const fileUrl = await import('node:url');

  const pluginsDir = path.join(path.dirname(fileUrl.fileURLToPath(import.meta.url)), 'plugins');

  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const mod = await import(`./plugins/${entry.name}/index.js`);
        if (mod.channelPlugin && typeof mod.channelPlugin.autoRegister === 'function') {
          channelPlugins.push(mod.channelPlugin);
        }
      } catch {
        // 插件加载失败，跳过
      }
    }
  } catch {
    // plugins 目录不存在，跳过
  }
}

/**
 * 根据 config.json 注册所有配置驱动渠道。
 * 不负责启动——由调用方通过 channelManager.startAll() 统一启动。
 *
 * @returns 已注册的渠道信息列表（用于注入到 System Prompt）
 */
export async function registerConfigChannels(
  channelManager: ChannelManager,
  cwd: string,
): Promise<ChannelsInfo[]> {
  // 自动发现插件（如果尚未手动注册）
  if (channelPlugins.length === 0) {
    await discoverPlugins();
  }

  const channelsInfo: ChannelsInfo[] = [];
  const configManager = new ConfigManager(cwd);
  await configManager.loadEnvKeys();
  const agentConfig = await configManager.load();

  for (const plugin of channelPlugins) {
    const config = (agentConfig.channels as Record<string, unknown>)?.[plugin.configKey];
    await plugin.autoRegister(channelManager, config, channelsInfo);
  }

  return channelsInfo;
}
