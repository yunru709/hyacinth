/**
 * channel-contributions.ts —— 通道贡献批（行数收尾第九批）。
 *
 * 迁移 ModelChannelRegistry（接线随迁：buildFromLegacy/initializeChannels/
 * setMainProvider）与 ModelRouter（needs channelRegistry）。角色通道注册
 * （compression/narration/orchestrator）随批完成：通道即配置锚点（可在
 * model-channels.json 覆写），实例由 registry 自建并携带通道默认 userId。
 *
 * 独立 LLM 调用方（压缩器/子 Agent）的**按次隔离**不在此处装配——
 * 消费方经 modelRouter.createScopedProvider(role, userId) 现建短命实例，
 * 通道配置仍由角色表统一管理（壳层方案 S4 后的 user_id 隔离模型）。
 *
 * 通道注册失败降级：try/catch 保留在批内（失败不影响主流程，语义与原内联一致）。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import { ModelRouter } from '../provider/model-router.js';
import { compressorUserId, narrationUserId, orchestratorUserId } from '../provider/user-id.js';
import type { AgentConfig } from '../setup/config.js';

export interface ChannelContributionDeps {
  cwd: string;
  config: AgentConfig;
  provider: import('../provider/interface.js').Provider;
}

export interface ChannelContributionOutputs {
  channelRegistry: ModelChannelRegistry;
  modelRouter: ModelRouter;
}

/** 执行通道贡献批（channelRegistry + 角色通道注册 + modelRouter） */
export async function runChannelContributions(
  deps: ChannelContributionDeps,
): Promise<ChannelContributionOutputs> {
  const { cwd, config, provider } = deps;
  const runner = new AssemblyRunner();
  runner.provide('cwd', cwd);
  runner.provide('config', config);
  runner.provide('provider', provider);

  const results = await runner.run([
    {
      id: 'channelRegistry',
      needs: ['cwd', 'config', 'provider'],
      provides: ['channelRegistry'],
      mount: (d) => {
        const channelRegistry = new ModelChannelRegistry(d.cwd as string);
        const cfg = d.config as AgentConfig;
        const providerActive = typeof cfg.provider === 'object'
          ? (cfg.provider as Record<string, unknown>).active as string | undefined
          : undefined;
        // 先尝试从 model-channels.json 加载（磁盘配置是单一真源）；仅当文件不存在时才走 legacy 构建。
        //
        // ⚠️ 2026-10-01 修正：此前**无条件** buildFromLegacy —— 那会让本 registry 完全忽略磁盘配置，
        // 并在随后的 upsertChannel → save() 里把"最小 legacy 配置"整份回写，**覆盖用户配置**
        // （实测后果：主对话专属通道 chat 被删、default 退回 openai，每次启动都复现）。
        // load() 内部已含"有文件用文件 / 无文件才 legacy"的分支，并会 initializeChannels()。
        channelRegistry.load(d.provider as import('../provider/interface.js').Provider, providerActive);
        // 将 ProviderManager 构建的带弹性层（重试+熔断+降级链）的主 Provider 注入 registry，
        // 替换 initializeChannels 中创建的裸 Provider
        // 厂商同样取**主对话实际在用的**，不用 config.provider.active（意图值，可能与实际不符）——
        // 否则每次启动都会把默认通道的 provider 覆盖成那个意图值（实测：本机 default 反复退回 openai，
        // 每次启动刷 3 条创建失败告警）。
        const mainProviderType = (d.provider as import('../provider/interface.js').Provider).getProviderType();
        channelRegistry.setMainProvider(d.provider as import('../provider/interface.js').Provider, mainProviderType);
        return { channelRegistry };
      },
    },
    {
      id: 'modelRouter',
      needs: ['provider', 'config', 'channelRegistry'],
      provides: ['modelRouter'],
      mount: (d) => ({
        modelRouter: new ModelRouter(
          d.provider as import('../provider/interface.js').Provider,
          (d.config as AgentConfig).models,
          (d.config as AgentConfig).local,
          d.channelRegistry as ModelChannelRegistry,
        ),
      }),
    },
  ]);

  const channelRegistry = results.get('channelRegistry') as ModelChannelRegistry;

  // ── 角色通道注册（通道默认 userId 实现 KVCache 隔离） ─────────────
  // 每个角色的 LLM 调用独立 KVCache 池，避免压缩/旁路/旁白污染主对话缓存。
  // 通道即配置锚点：实例由 registry 按 config 自建（key 从 env 解析），
  // 无 key 时实例创建失败 → getProvider 自动降级 main，不影响主流程。
  // 按次隔离（session 粒度）由消费方经 createScopedProvider 现建，不经此处。
  // ── 角色通道：**只补建缺失的**，绝不覆盖已有配置 ───────────────────
  //
  // ⚠️ 2026-10-02 修正：旧实现在装配期用「主对话的类型 + 模型」**无条件 upsert** 这三条通道
  // （浅合并 + save 落盘）⇒ 用户为通道单独配的 provider/model **每次启动都被冲掉**；
  // 且当主对话类型与其模型名不同源时（如 commandcode 配着带 `deepseek/…` 前缀的模型 id），
  // 会直接写出「厂商与模型不匹配」的坏配置（实测：default 被写成 deepseek + commandcode 的模型名）。
  //
  // 原则：**磁盘是权威**，装配只补缺；已有的通道配置与角色映射一律不动。
  const activeType = provider.getProviderType();
  const model = provider.getModel();
  try {
    const channelNames = new Set(channelRegistry.listChannelNames());
    const roles = channelRegistry.listRoles();
    /** 通道不存在才补建；已存在则尊重磁盘配置 */
    const ensureChannel = (name: string, extra: Record<string, unknown>): void => {
      if (channelNames.has(name)) return;
      channelRegistry.upsertChannel(name, { provider: activeType, model, ...extra });
    };
    /** 角色映射不存在才建立；已存在（含运行时发现的）则不动 */
    const ensureRole = (role: string, channel: string): void => {
      if (roles[role]) return;
      channelRegistry.setRoleMapping(role, channel);
    };

    // 压缩器：独立通道（可能与主 Agent/旁路并发运行），thinking 关闭
    ensureChannel('compression', { userId: compressorUserId(), thinking: false });
    ensureRole('compression', 'compression');
    // 旁路 Agent：narration 与 orchestrator 各自独立实例（userId 跟随通道，
    // 模式切换经 BypassManager 激活对应 agent，天然用对隔离池，无需运行时 setUserId）
    ensureChannel('orchestrator', { userId: orchestratorUserId(), thinking: false });
    ensureRole('orchestrator', 'orchestrator');
    ensureChannel('narration', { userId: narrationUserId(), thinking: false });
    ensureRole('narration', 'narration');
  } catch {
    // 通道注册失败不影响主流程
  }

  return {
    channelRegistry,
    modelRouter: results.get('modelRouter') as ModelRouter,
  };
}
