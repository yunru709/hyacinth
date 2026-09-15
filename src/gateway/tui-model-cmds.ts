/**
 * tui-model-cmds.ts —— model 非 local 子命令模块（tui.ts 深拆第六批）。
 *
 * 从 handleSlashSubCommand 迁出 model 的在线/设置命令族：switch、provider、
 * source、thinking（含 8 档子命令）、show-thinking、info、context。
 * 沿用第五批 tui-model-local 的「命令处理器外移」样板：工厂 + deps 注入，
 * case 只留一行转发。
 *
 * 行为零变更：提示文案、异步时序、modelName/providerTypeStart/showThinking
 * 外部状态经回调写回（不动 runTui 的 let 绑定）；applyThinking 与
 * updateTokenEstimate 为 handleInput/runTui 内部函数，经注入调用。
 */

import type { TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';
import type { LocalModelModule } from '../local-model/index.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { execViaProtocol } from './tui-channel-cmds.js';
import { CommandRegistry } from '../ui/command-registry.js';
import type { StateSnapshot } from '../ui-protocol/types.js';

/** model 非 local 命令的最小依赖面 */
export interface TuiModelCmdDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  localModel: Pick<LocalModelModule, 'list' | 'getActive' | 'getBridge' | 'switch'>;
  protocolSend: (method: string, params?: unknown) => Promise<unknown>;
  setConfig: (path: string, value: unknown) => Promise<void>;
  /** 经协议 state.get 刷新缓存并返回快照（切换后校验实际生效值用） */
  refreshStatusFromProtocol: () => Promise<StateSnapshot | undefined>;
  /** 当前 provider 类型（本地缓存，由协议事件/命令维护；替代 getLoop().getActiveProvider） */
  getProviderType: () => string;
  /** 当前 model 名（本地缓存） */
  getModelName: () => string;
  /** handleInput 内部函数：thinking 配置 */
  applyThinking: (action: string) => Promise<void>;
  /** runTui 内部函数：token 估算刷新 */
  updateTokenEstimate: () => void;
  /** showThinking 外部状态读写（/model show-thinking 切换） */
  getShowThinking: () => boolean;
  setShowThinking: (v: boolean) => void;
}

/** 创建 model 非 local 命令处理器 */
export function createModelCmds(deps: TuiModelCmdDeps) {
  const {
    tui, chatLog, localModel, protocolSend, setConfig, refreshStatusFromProtocol,
    getProviderType, getModelName,
    applyThinking, updateTokenEstimate, getShowThinking, setShowThinking,
  } = deps;

  /** 执行一个 model 子命令（cmdPath 形如 'model/switch' / 'model/thinking/on'） */
  async function handle(cmdPath: string, restArgs: string): Promise<void> {
    switch (cmdPath) {
      // ── model/switch：设置当前 provider 的模型名 ──
      case 'model/settings/switch':
      case 'model/switch': {
        if (!restArgs) {
          chatLog.addSystem(theme.warning('Usage: /model switch <model-name>'));
          tui.requestRender();
          return;
        }
        const providerType = getProviderType();
        // 经协议切换：协议层是 provider 选择唯一写入口（含落盘 provider.<p>.model）。
        // UI 不再自行 setConfig —— 直连 config 会绕过协议层的校验/持久化/通道同步。
        try {
          await protocolSend('model.switch', { provider: providerType, model: String(restArgs) });
          chatLog.addSystem(
            theme.success('Model name set to ') + theme.fg(String(restArgs)) + theme.dim(` (provider: ${providerType})`),
          );
        } catch (err) {
          chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
        }
        tui.requestRender();
        await refreshStatusFromProtocol();
        return;
      }

      // ── model/provider：切换 provider ──
      case 'model/settings/provider':
      case 'model/provider': {
        if (!restArgs) {
          chatLog.addSystem(theme.warning('Usage: /model provider <anthropic|openai|deepseek|gemini|groq|xai|mistral|openrouter|moonshot|qwen|zhipu|minimax|mimo|volcengine|local>'));
          tui.requestRender();
          return;
        }

        if (restArgs === 'local') {
          const lmList = localModel.list();

          // 无已注册模型 → 检查本地模型配置或直接切
          if (lmList.length === 0) {
            const { getLocalProviderConfigLoader } = await import('../provider/local-config.js');
            const localCfg = getLocalProviderConfigLoader();
            if (localCfg?.defaultModel) {
              // 本地模型已配置 → 直接切换（model.switch 委托 loop.switchProvider，含 registry 同步）
              try {
                await protocolSend('model.switch', { provider: 'local' });
                chatLog.addSystem(theme.success(`Switched to local (${localCfg.baseUrl}, ${localCfg.defaultModel})`));
                chatLog.addSystem(theme.dim('Register models via /model local/register for process management.'));
                await refreshStatusFromProtocol();
              } catch (err) {
                chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
              }
            } else {
              chatLog.addSystem(theme.warning('No local models configured.'));
              chatLog.addSystem(theme.dim('Set a local model in config or register models via /model local/register.'));
            }
            tui.requestRender();
            return;
          }

          const targetName = localModel.getActive() ?? lmList[0].name;

          localModel.switch(targetName).then(async (info) => {
            if (info) {
              await setConfig('provider.local', {
                type: 'local',
                model: info.modelFile ?? targetName,
                baseUrl: info.baseUrl,
              });
              await setConfig('provider.local.modelKey', targetName);
              try {
                await protocolSend('model.switch', { provider: 'local' });
                chatLog.addSystem(theme.success(`Switched to local model: ${targetName} (port ${info.port})`));
                await refreshStatusFromProtocol();
              } catch (swErr) {
                chatLog.addSystem(theme.error(`Failed: ${(swErr as Error).message}`));
              }
            } else {
              chatLog.addSystem(theme.error(`Failed to start ${targetName}`));
            }
            tui.requestRender();
          }).catch((e) => {
            chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
            tui.requestRender();
          });
          return;
        }

        localModel.getBridge().stopAll().catch(() => {});
        try {
          // 协议层统一落盘 provider.active（UI 不再自行 setConfig）
          await protocolSend('model.switch', { provider: restArgs });
        } catch (e) {
          chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
          tui.requestRender();
          return;
        }
        chatLog.addSystem(
          theme.success('Provider switched to ') + theme.fg(String(restArgs)) + theme.dim(' (persisted)'),
        );
        tui.requestRender();
        await refreshStatusFromProtocol();
        return;
      }

      // ── model/source：角色 → 模型源映射 ──
      case 'model/settings/source':
      case 'model/source': {
        if (!restArgs) {
          chatLog.addSystem(theme.warning('Usage: /model source <role> <main|local|channel-name>'));
          tui.requestRender();
          return;
        }
        const parts2 = restArgs.split(/\s+/).filter(Boolean);
        if (parts2.length < 2) {
          chatLog.addSystem(theme.warning('Usage: /model source <assessment|planning|compression|sub-agent|all> <main|local|channel-name>'));
          tui.requestRender();
          return;
        }
        const roleArg = parts2[0].toLowerCase();
        const sourceArg = parts2[1];
        const validRoles = ['assessment', 'planning', 'compression', 'sub-agent', 'all'];
        if (!validRoles.includes(roleArg)) {
          chatLog.addSystem(theme.warning('Role must be: assessment, planning, compression, sub-agent, or all'));
          tui.requestRender();
          return;
        }
        // 通道名经协议 model.listChannels 获取（不再持有 modelRouter/registry）
        const chRes = (await protocolSend('model.listChannels')) as
          | Array<{ name?: string }>
          | { channels?: Array<{ name?: string }> }
          | null
          | undefined;
        const channelNames = (Array.isArray(chRes) ? chRes : (chRes?.channels ?? [])).map((c) => c.name ?? '').filter(Boolean);
        const isChannelName = channelNames.includes(sourceArg);

        try {
          if (isChannelName) {
            // 映射到已注册的通道：逐 role 经 model.setChannelRole 写（与 WebUI 同路径，
            // 触发 MODEL_CHANGE 广播）。协议不可达即失败提示（无 loop 可降级）。
            const roles = roleArg === 'all'
              ? ['assessment', 'planning', 'compression', 'sub-agent']
              : [roleArg];
            let allOk = true;
            for (const r of roles) {
              const via = await execViaProtocol(() => protocolSend, 'model.setChannelRole', { role: r, channel: sourceArg });
              if (!via) allOk = false;
            }
            if (allOk) {
              chatLog.addSystem(theme.success(`Mapped ${roles.join(', ')} → channel "${sourceArg}"`));
            } else {
              chatLog.addSystem(theme.error(`Role mapping failed (protocol unavailable)`));
            }
          } else {
            chatLog.addSystem(theme.warning(`Channel "${sourceArg}" not found. Available: ${channelNames.join(', ') || '(none)'}. Use /channel add ${sourceArg} <provider> [model] to create it.`));
          }
        } catch (e) {
          chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
        }
        tui.requestRender();
        await refreshStatusFromProtocol();
        return;
      }

      // ── model/thinking 与 8 档子命令 ──
      case 'model/settings/thinking':
      case 'model/thinking': {
        await applyThinking(restArgs);
        return;
      }
      case 'model/settings/thinking/on':
      case 'model/thinking/on':     await applyThinking('on'); return;
      case 'model/settings/thinking/off':
      case 'model/thinking/off':    await applyThinking('off'); return;
      case 'model/settings/thinking/high':
      case 'model/thinking/high':   await applyThinking('high'); return;
      case 'model/settings/thinking/max':
      case 'model/thinking/max':    await applyThinking('max'); return;
      case 'model/settings/thinking/4k':
      case 'model/thinking/4k':     await applyThinking('4k'); return;
      case 'model/settings/thinking/8k':
      case 'model/thinking/8k':     await applyThinking('8k'); return;
      case 'model/settings/thinking/16k':
      case 'model/thinking/16k':    await applyThinking('16k'); return;
      case 'model/settings/thinking/32k':
      case 'model/thinking/32k':    await applyThinking('32k'); return;

      // ── model/show-thinking：切换 thinking 内容显示 ──
      case 'model/settings/show-thinking':
      case 'model/show-thinking': {
        setShowThinking(!getShowThinking());
        chatLog.addSystem(
          theme.success(getShowThinking() ? 'Thinking content will be shown' : 'Thinking content hidden'),
        );
        tui.requestRender();
        updateTokenEstimate();
        return;
      }

      // ── model/info：模型信息 ──
      case 'model/settings/info':
      case 'model/info': {
        // 全部信息经协议获取（state.get + model.listChannels/listRoles/sources），
        // 不再持有 loop/modelRouter（纯协议客户端化）
        const snap = (await protocolSend('state.get')) as
          | { provider?: string; model?: string; routeMode?: string; isLocal?: boolean }
          | null
          | undefined;
        const providerName = snap?.provider ?? 'unknown';
        const modelName = snap?.model ?? 'unknown';
        const lines: string[] = [];
        lines.push(theme.accent('=== Model Info ==='));
        lines.push('  Provider: ' + theme.fg(providerName));
        lines.push('  Model:    ' + theme.fg(modelName));
        if (snap?.routeMode) {
          lines.push('  Route:    ' + theme.fg(snap.routeMode) + (snap.isLocal ? theme.success(' (local)') : theme.accent(' (online)')));
        }
        // 通道信息（协议读取）
        const chRes = (await protocolSend('model.listChannels')) as
          | Array<{ name: string; provider: string; model?: string }>
          | { channels?: Array<{ name: string; provider: string; model?: string }> }
          | null
          | undefined;
        const channels = (Array.isArray(chRes) ? chRes : (chRes?.channels ?? [])) as Array<{ name: string; provider: string; model?: string }>;
        const roleRes = (await protocolSend('model.listRoles')) as
          | Record<string, string>
          | { roles?: Record<string, string> }
          | null
          | undefined;
        const roles = (roleRes && !Array.isArray(roleRes) && typeof roleRes === 'object' && 'roles' in roleRes
          ? (roleRes as { roles: Record<string, string> }).roles
          : (roleRes as Record<string, string> | null | undefined)) ?? {};
        if (channels.length > 1 || Object.keys(roles).some(r => roles[r] !== 'main')) {
          lines.push(theme.dim('  ── Channels ──'));
          for (const ch of channels) {
            const chRoles = Object.entries(roles)
              .filter(([, cn]) => cn === ch.name)
              .map(([r]) => r);
            const roleStr = chRoles.length > 0 ? ' ← ' + chRoles.join(', ') : '';
            lines.push(theme.dim(`    ${ch.name}: ${ch.provider}${ch.model ? '/' + ch.model : ''}`) + theme.fg(roleStr));
          }
        }
        // 角色 → 模型源映射（协议读取）
        const srcRes = (await protocolSend('model.sources')) as { sources?: Record<string, string> | null } | null | undefined;
        const sources = srcRes?.sources ?? null;
        if (sources) {
          const labels: Record<string, string> = { assessment: '评估', planning: '规划', compression: '压缩' };
          for (const [role, src] of Object.entries(sources)) {
            const label = labels[role] ?? role;
            const srcColor = src === 'local' ? theme.success(String(src)) : theme.accent(String(src));
            lines.push('    ' + theme.fg(label) + theme.dim(': ') + srcColor);
          }
        }
        chatLog.addSystem(lines.join('\n'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }

      // ── model/settings/context：上下文窗口 ──
      case 'model/settings/context': {
        if (!restArgs) {
          const modelCtxWindow = getModelContextWindow(getProviderType(), getModelName());
          chatLog.addSystem(theme.warning('Usage: /model settings context <tokens>') + theme.dim(` (1-${modelCtxWindow.toLocaleString()})`));
          tui.requestRender();
          updateTokenEstimate();
          return;
        }
        const tokens = parseInt(restArgs.trim(), 10);
        const modelCtxWindow = getModelContextWindow(getProviderType(), getModelName());
        const upper = modelCtxWindow;
        if (isNaN(tokens) || tokens < 1 || tokens > upper) {
          chatLog.addSystem(theme.warning(`Usage: /model settings context <1-${upper.toLocaleString()}>`) + theme.dim(` (model: ${getModelName()})`));
          tui.requestRender();
          updateTokenEstimate();
          return;
        }
        await setConfig('session.maxContext', tokens);
        chatLog.addSystem(theme.success('Max context set to ') + theme.fg(tokens.toLocaleString() + ' tokens'));
        await refreshStatusFromProtocol();
        updateTokenEstimate();
        return;
      }

      default:
        // ── 前缀匹配（非 case）：model/online/<p>/<m|config>、model/local_<name>、model/current_online ──
        // 在线模型切换，两种入口统一：
        //   a) 面板多级路径：model/online/<provider>/<model|config>
        //   b) 直接命令：/model online <provider> <model>（cmdPath 为 'model/online'，参数在 restArgs）
        if (cmdPath === 'model/online' || cmdPath.startsWith('model/online/')) {
          const pathParts = cmdPath.startsWith('model/online/') ? cmdPath.split('/') : [];
          const argParts = restArgs.split(/\s+/).filter(Boolean);
          const provider = pathParts[2] ?? argParts[0];
          const sub = pathParts[3] ?? argParts[1];
          if (!provider || !sub) {
            // 无参数：提示用法并列出可用厂商（与面板同源，经 childrenProvider 动态生成）
            let providerNames = '';
            try {
              const onlineDef = CommandRegistry.getInstance().find('model/online');
              const children = onlineDef?.childrenProvider
                ? await onlineDef.childrenProvider()
                : (onlineDef?.children ?? []);
              providerNames = children.map((c) => c.name).join(', ');
            } catch { /* registry 未初始化等场景下降级为空列表 */ }
            chatLog.addSystem(
              theme.warning('Usage: /model online <provider> <model>') +
              (providerNames ? theme.dim(`\nProviders: ${providerNames}`) : ''),
            );
            tui.requestRender();
            return;
          }
          if (sub === 'config') {
            chatLog.addSystem(theme.accent(`Configure ${provider}: Use /context <tokens> to adjust context window`));
            tui.requestRender();
            return;
          }
          localModel.getBridge().stopAll().catch(() => {});
          try {
            // UI 不再写配置。协议层 model.switch 是 provider 选择**唯一**的写入口：
            // 由它统一完成「应用运行时 + 落盘 provider.active/<p>.model/routeMode + 同步 main 通道」，
            // 并返回**生效值**。UI 只渲染返回值，不再自行 setConfig、也不再发第二次
            // state.get 回来比对——旧实现「先写盘 + 再发命令 + 再读回来校验」是三条写/读
            // 路径并发，既是 Switch incomplete 误报的来源，也是运行时与配置分叉的根源。
            const res = (await protocolSend('model.switch', { provider, model: sub })) as
              | { provider?: string; model?: string }
              | undefined;
            const effProvider = res?.provider ?? '';
            const effModel = res?.model ?? '';
            if (effProvider === provider && effModel === sub) {
              chatLog.addSystem(theme.success(`Switched to ${provider}/${sub}`));
            } else if (effProvider) {
              // 后端返回了生效值但与请求不符（如被路由改写）——如实报告，不掩盖
              chatLog.addSystem(
                theme.warning(`Switch incomplete: active ${effProvider}/${effModel || '?'}, requested ${provider}/${sub}`),
              );
            } else {
              chatLog.addSystem(theme.error('Switch failed: backend returned no result'));
            }
            await refreshStatusFromProtocol();
          } catch (err) {
            chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
          }
          tui.requestRender();
          return;
        }
        // 本地模型 L1 直接切换: model/local_<modelName>
        if (cmdPath.startsWith('model/local_')) {
          const lmName = cmdPath.slice('model/local_'.length);
          const lm = localModel.list().find((m) => m.name === lmName);
          if (lm) {
            localModel.switch(lmName).then(async (info) => {
              if (info) {
                chatLog.addSystem(theme.success(`Local model ${lmName} started on port ${info.port}`));
                await setConfig('provider.local', {
                  type: 'local',
                  model: info.modelFile ?? lmName,
                  baseUrl: info.baseUrl,
                });
                await setConfig('provider.local.modelKey', lmName);
                try {
                  await protocolSend('model.switch', { provider: 'local' });
                  await refreshStatusFromProtocol();
                } catch (swErr) {
                  chatLog.addSystem(theme.warning(`Switch to local: ${(swErr as Error).message}`));
                }
              } else {
                chatLog.addSystem(theme.error(`Failed to start ${lmName}`));
              }
              tui.requestRender();
            }).catch((e) => {
              chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
              tui.requestRender();
            });
            tui.requestRender();
            return;
          }
        }
        // 在线模型 L1 直接切换: model/current_online
        if (cmdPath === 'model/current_online') {
          chatLog.addSystem(theme.dim('Already using current online model'));
          tui.requestRender();
          return;
        }
        return;
    }
  }

  return { handle };
}

export type TuiModelCmds = ReturnType<typeof createModelCmds>;

