/**
 * tui-channel-cmds.ts —— channel/* 通道管理命令模块（tui.ts 深拆第八批）。
 *
 * 迁出 channel/list、add、remove、role、<name>/info|model|reset（约 150 行）。
 * 沿用命令处理器外移样板。核心依赖是 ModelChannelRegistry——tui.ts 原用
 * `(loop as any).modelRouter`（P5-13 触手残留），提取时以类型化
 * ChannelRegistryLike 注入（模块内不再出现 as any）。
 *
 * 协议收口（T1）：channel/* 写操作经协议层 model.*Channel 方法执行（与
 * WebUI 同一实现路径），registry 直连保留为降级路径——协议未就绪（启动
 * 窗口期 protocolSend 为 no-op）或协议调用失败时回落直连，行为零变更。
 * registry 仍用于只读回显与降级，这是设计意图，不删。
 *
 * 行为零变更：list/add/remove/role/info/model/reset 全部提示文案与
 * registry 调用原样保留。
 */

import type { TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';

/** 单通道信息（registry.getChannelInfo 返回） */
export interface ChannelInfo {
  name: string;
  provider: string;
  model: string;
  providerType: string;
  description?: string;
  roles: string[];
  isMain?: boolean;
}

/** ModelChannelRegistry 的最小方法面（类型化，替代 tui.ts 的 (loop as any).modelRouter） */
export interface ChannelRegistryLike {
  listChannels(): Array<{ name: string; provider: string; model?: string }>;
  listRoles(): Record<string, string>;
  upsertChannel(name: string, opts: { provider?: string; model?: string }): unknown;
  getChannelInfo(name: string): ChannelInfo | undefined;
  removeChannel(name: string): unknown;
  setRoleMapping(role: string, channel: string): unknown;
  setChannelModel(name: string, provider?: string, model?: string): unknown;
  resetChannelModel(name: string): unknown;
}

/** 协议发送器（与 tui.ts 的 protocolSend 签名一致；lazy getter 未就绪返回 null） */
export type ProtocolSendLike = (method: string, params?: unknown) => Promise<unknown>;

/**
 * 经协议层调用一个 model 域方法（channel/* 收口的统一通道，T3 复用）。
 * 返回协议响应对象；null 表示协议未达成 → 由调用方降级到 registry 直连。
 * 归入降级的情况：getSend 未就绪 / protocolSend 为启动窗口期 no-op（返回
 * undefined）/ WS 未连接（resolve undefined）/ 域方法 throw（RPC ok=false
 * 无 result，如 registry 校验错误——降级直连会以同一 registry 异常复现，
 * 用户看到的 Failed 文案与改造前一致）。
 */
export async function execViaProtocol(
  getSend: () => ProtocolSendLike | null,
  method: string,
  params?: unknown,
): Promise<unknown | null> {
  const send = getSend();
  if (!send) return null;
  try {
    const raw = await send(method, params);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/** channel/* 命令的最小依赖面 */
export interface TuiChannelCmdDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  /** 协议发送器 getter（主路径；initialize 完成前返回 no-op，协议调用归为降级） */
  getProtocolSend: () => ProtocolSendLike | null;
  /** 返回通道注册表（经调用方从 loop.modelRouter 取；缺失返回 null）。降级路径 */
  getChannelRegistry: () => ChannelRegistryLike | null;
}

/** 通用渠道命令分发的依赖面（cmdPath 首段为渠道 id，如 "clawbot/login"） */
export interface TuiChannelDispatchDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  /** 渠道管理器（channelManager.get(chId) → 渠道状态） */
  getChannelManager: () => {
    get(id: string): { handler: { handleTuiCommand?(cmd: string, args: string): Promise<string | null> } } | undefined;
  };
}

/** 创建通用渠道命令分发器（未命中返回 false，调用方继续兜底） */
export function createChannelDispatch(deps: TuiChannelDispatchDeps) {
  const { tui, chatLog, getChannelManager } = deps;

  /** 尝试把 cmdPath 首段作为渠道 id 分发；返回是否已消费 */
  async function handle(cmdPath: string, restArgs: string): Promise<boolean> {
    const slashIdx = cmdPath.indexOf('/');
    if (slashIdx <= 0) return false;
    const chId = cmdPath.slice(0, slashIdx);
    const chState = getChannelManager().get(chId);
    if (chState?.handler.handleTuiCommand) {
      const result = await chState.handler.handleTuiCommand(cmdPath, restArgs);
      if (result !== null) {
        chatLog.addSystem(result);
        tui.requestRender();
        return true;
      }
    }
    return false;
  }

  return { handle };
}

/** 创建 channel/* 命令处理器 */
export function createChannelCmds(deps: TuiChannelCmdDeps) {
  const { tui, chatLog, getChannelRegistry, getProtocolSend } = deps;

  /** 执行一个 channel 子命令（cmdPath 形如 'channel/list' / 'channel/<name>/model'） */
  async function handle(cmdPath: string, restArgs: string): Promise<void> {
    const registry = getChannelRegistry();

    const warnNoRegistry = () => {
      chatLog.addSystem(theme.warning('ModelRouter not available'));
      tui.requestRender();
    };

    if (cmdPath === 'channel/list') {
      // 读操作：协议优先（与 WebUI model.listChannels/listRoles 同路径），
      // 协议返回 ok 不再降级（避免重复渲染两次）
      const viaList = await execViaProtocol(getProtocolSend, 'model.listChannels');
      const viaRoles = viaList
        ? await execViaProtocol(getProtocolSend, 'model.listRoles')
        : null;
      if (viaList && viaRoles) {
        renderList(
          (viaList as { channels: Array<{ name: string; provider: string; model?: string }> }).channels,
          (viaRoles as { roles: Record<string, string> }).roles,
        );
        return;
      }
      if (!registry) {
        warnNoRegistry();
        return;
      }
      renderList(registry.listChannels(), registry.listRoles());
      return;
    }

    if (cmdPath === 'channel/add') {
      if (!restArgs) {
        chatLog.addSystem(theme.warning('Usage: /channel add <name> [provider] [model]'));
        tui.requestRender();
        return;
      }
      const parts = restArgs.split(/\s+/).filter(Boolean);
      const [name, provider, model] = parts;
      const via = await execViaProtocol(getProtocolSend, 'model.upsertChannel', { name, provider, model });
      if (via) {
        // 回显走 registry 只读查询（读操作无副作用）；registry 缺失时退回请求参数
        const info = registry?.getChannelInfo(name);
        const shownProvider = info?.provider ?? provider;
        chatLog.addSystem(theme.success(`Channel "${name}" added (${shownProvider}${model ? '/' + model : ''})`));
        tui.requestRender();
        return;
      }
      // ── 降级：原直连路径（行为零变更）──
      if (!registry) {
        warnNoRegistry();
        return;
      }
      try {
        registry.upsertChannel(name, { provider, model });
        const info = registry.getChannelInfo(name);
        chatLog.addSystem(theme.success(`Channel "${name}" added (${info?.provider}${model ? '/' + model : ''})`));
      } catch (e) {
        chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
      }
      tui.requestRender();
      return;
    }

    if (cmdPath === 'channel/remove') {
      if (!restArgs) {
        chatLog.addSystem(theme.warning('Usage: /channel remove <name>'));
        tui.requestRender();
        return;
      }
      const name = restArgs.trim();
      const via = await execViaProtocol(getProtocolSend, 'model.removeChannel', { name });
      if (via) {
        chatLog.addSystem(theme.success(`Channel "${name}" removed`));
        tui.requestRender();
        return;
      }
      // ── 降级：原直连路径（行为零变更）──
      if (!registry) {
        warnNoRegistry();
        return;
      }
      try {
        registry.removeChannel(name);
        chatLog.addSystem(theme.success(`Channel "${name}" removed`));
      } catch (e) {
        chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
      }
      tui.requestRender();
      return;
    }

    if (cmdPath === 'channel/role') {
      if (!restArgs) {
        chatLog.addSystem(theme.warning('Usage: /channel role <role> <channel>'));
        tui.requestRender();
        return;
      }
      const parts = restArgs.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        chatLog.addSystem(theme.warning('Usage: /channel role <role> <channel>'));
        tui.requestRender();
        return;
      }
      const [role, channel] = parts;
      const via = await execViaProtocol(getProtocolSend, 'model.setChannelRole', { role, channel });
      if (via) {
        chatLog.addSystem(theme.success(`Role "${role}" → channel "${channel}"`));
        tui.requestRender();
        return;
      }
      // ── 降级：原直连路径（行为零变更）──
      if (!registry) {
        warnNoRegistry();
        return;
      }
      try {
        registry.setRoleMapping(role, channel);
        chatLog.addSystem(theme.success(`Role "${role}" → channel "${channel}"`));
      } catch (e) {
        chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
      }
      tui.requestRender();
      return;
    }

    // ── 通道子命令: channel/<name>/info | /model | /reset ──
    const chMatch = cmdPath.match(/^channel\/([^/]+)\/(info|model|reset)$/);
    if (chMatch) {
      const chName = chMatch[1];
      const action = chMatch[2];

      if (action === 'info') {
        // 读操作：协议优先，协议返回 ok 不再降级
        const via = await execViaProtocol(getProtocolSend, 'model.getChannelInfo', { name: chName });
        const info = via
          ? (via as { info: ChannelInfo | null }).info ?? undefined
          : registry?.getChannelInfo(chName);
        if (!via && !registry) {
          warnNoRegistry();
          return;
        }
        if (!info) {
          chatLog.addSystem(theme.warning(`Channel "${chName}" not found`));
        } else {
          renderInfo(info);
        }
        tui.requestRender();
        return;
      }

      if (action === 'model') {
        const parts = (restArgs || '').split(/\s+/).filter(Boolean);
        if (parts.length < 1) {
          chatLog.addSystem(theme.warning(`Usage: /channel/${chName}/model <provider> [model-name]`));
          tui.requestRender();
          return;
        }
        const provider = parts[0];
        const model = parts[1] || undefined;
        const via = await execViaProtocol(getProtocolSend, 'model.setChannelModel', { name: chName, provider, model });
        if (via) {
          const updated = registry?.getChannelInfo(chName);
          const shownProvider = updated?.provider ?? provider;
          const shownModel = updated?.model ?? model;
          chatLog.addSystem(theme.success(`Channel "${chName}" model set → ${shownProvider}/${shownModel} (runtime only, not persisted)`));
          tui.requestRender();
          return;
        }
        // ── 降级：原直连路径（行为零变更）──
        if (!registry) {
          warnNoRegistry();
          return;
        }
        try {
          registry.setChannelModel(chName, provider, model);
          const updated = registry.getChannelInfo(chName);
          chatLog.addSystem(theme.success(`Channel "${chName}" model set → ${updated?.provider}/${updated?.model} (runtime only, not persisted)`));
        } catch (e) {
          chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
        }
        tui.requestRender();
        return;
      }

      if (action === 'reset') {
        const via = await execViaProtocol(getProtocolSend, 'model.resetChannelModel', { name: chName });
        if (via) {
          const info = registry?.getChannelInfo(chName)
            ?? (await execViaProtocol(getProtocolSend, 'model.getChannelInfo', { name: chName }) as { info: ChannelInfo | null } | null)?.info ?? undefined;
          chatLog.addSystem(theme.success(`Channel "${chName}" reset → ${info?.provider}/${info?.model}`));
          tui.requestRender();
          return;
        }
        // ── 降级：原直连路径（行为零变更）──
        if (!registry) {
          warnNoRegistry();
          return;
        }
        try {
          registry.resetChannelModel(chName);
          const info = registry.getChannelInfo(chName);
          chatLog.addSystem(theme.success(`Channel "${chName}" reset → ${info?.provider}/${info?.model}`));
        } catch (e) {
          chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
        }
        tui.requestRender();
        return;
      }
    }
  }

  /** channel/list 渲染（协议与降级路径共用，文案与改造前逐字一致） */
  function renderList(
    channels: Array<{ name: string; provider: string; model?: string }>,
    roles: Record<string, string>,
  ): void {
    if (channels.length === 0) {
      chatLog.addSystem(theme.dim('No model channels configured. All roles use main provider.'));
    } else {
      const lines: string[] = [theme.accent('=== Model Channels ===')];
      for (const ch of channels) {
        const chRoles = Object.entries(roles)
          .filter(([, cn]) => cn === ch.name)
          .map(([r]) => r);
        const roleStr = chRoles.length > 0 ? theme.dim(' → ') + theme.fg(chRoles.join(', ')) : '';
        lines.push(theme.fg(`  ${ch.name}`) + theme.dim(`: ${ch.provider}/${ch.model || 'default'}`) + roleStr);
      }
      lines.push('');
      lines.push(theme.accent('=== Role Mappings ==='));
      for (const [role, channel] of Object.entries(roles)) {
        lines.push(theme.dim(`  ${role}`) + ' → ' + theme.fg(String(channel)));
      }
      chatLog.addSystem(lines.join('\n'));
    }
    tui.requestRender();
  }

  /** channel/<name>/info 渲染（协议与降级路径共用，文案与改造前逐字一致） */
  function renderInfo(info: ChannelInfo): void {
    const lines: string[] = [theme.accent(`=== Channel: ${info.name}${info.isMain ? ' (main)' : ''} ===`)];
    lines.push(theme.fg('  Provider: ') + info.provider);
    lines.push(theme.fg('  Model:    ') + info.model);
    lines.push(theme.fg('  Type:     ') + info.providerType);
    if (info.description) lines.push(theme.dim('  Desc:     ') + info.description);
    if (info.roles.length > 0) lines.push(theme.fg('  Roles:    ') + info.roles.join(', '));
    chatLog.addSystem(lines.join('\n'));
  }

  return { handle };
}

export type TuiChannelCmds = ReturnType<typeof createChannelCmds>;
