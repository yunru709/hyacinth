/**
 * startup-resolution.ts —— 「启动时用哪家 provider / 哪个模型」的**唯一解析**（2026-10-02）
 *
 * 背景：这个决定过去读 `config.json` 的 `provider.active` —— 一个"意图值"字段。
 * 它会被多处写（协议层切换、CLI 命令、**其它进程的内存快照覆盖**），于是经常停在
 * 一个**不可服务的值**上（本机长期写着没有 key 的 `openai`），逼得启动链路先做
 * "可服务性判定"、不行就"忽略 + 告警"—— 补丁越堆越多，用户看到的仍是困惑。
 *
 * 现在主对话的真源是 `model-channels.json` 的 **chat 通道**（切换默认落盘，
 * 见 model.switch 的 setChannelModel('chat', …)）。本模块把启动解析钉在这一个真源上：
 *   · 有 chat 通道 ⇒ 用它（厂商 + 模型）；
 *   · 没有 / 文件损坏 ⇒ 返回 `none`，交给既有默认链路（显式参数 / 环境探测）；
 *   · **完全不读 `provider.active`** ⇒ 该字段从此可安全退役：写它、被覆盖，都不再影响行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StartupProviderResolution {
  provider?: string;
  model?: string;
  source: 'chat-channel' | 'none';
}

const CHAT_ROLE = 'chat';
const DEFAULT_CHAT_CHANNEL = 'chat';

/** 通道配置文件路径（可注入 home，便于测试） */
export function defaultChannelsPath(home: string = os.homedir()): string {
  return path.join(home, '.agent', 'model-channels.json');
}

/**
 * 解析启动 provider。纯读、无副作用；任何异常都退化为 `none`（启动不该被一个坏文件拖垮）。
 */
export function resolveStartupProvider(channelsFile?: string): StartupProviderResolution {
  const file = channelsFile ?? defaultChannelsPath();
  try {
    if (!fs.existsSync(file)) return { source: 'none' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      channels?: Record<string, { provider?: string; model?: string }>;
      roles?: Record<string, string>;
    };
    const channels = parsed.channels ?? {};
    const channelName = parsed.roles?.[CHAT_ROLE] ?? DEFAULT_CHAT_CHANNEL;
    const chat = channels[channelName];
    if (!chat?.provider) return { source: 'none' };
    return { provider: chat.provider, model: chat.model, source: 'chat-channel' };
  } catch {
    return { source: 'none' };
  }
}
