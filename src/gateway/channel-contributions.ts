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
        channelRegistry.setMainProvider(d.provider as import('../provider/interface.js').Provider, providerActive);
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
  const providerActive = typeof config.provider === 'object'
    ? (config.provider as Record<string, unknown>).active as string | undefined
    : undefined;
  try {
    if (providerActive) {
      // ⚠️ 2026-10-01 修正：角色通道的厂商必须取**主对话实际在用的**（provider.getProviderType()），
      // 不能取 config.provider.active —— 后者是老机制的"意图值"，可能与实际不符（本机就写着一个
      // 没有 key 的 openai）。用它会导致每次启动把三条角色通道的 provider 覆盖成 openai、创建全失败，
      // 且 upsertChannel 触发 save() 把用户配置整份写坏（实测：default/compression/orchestrator/
      // narration 全部退回 openai）。
      const activeType = provider.getProviderType();
      const model = provider.getModel();
      // 压缩器：独立通道（可能与主 Agent/旁路并发运行），thinking 关闭
      channelRegistry.upsertChannel('compression', {
        provider: activeType, model, userId: compressorUserId(), thinking: false,
      });
      channelRegistry.setRoleMapping('compression', 'compression');
      // 旁路 Agent：narration 与 orchestrator 各自独立实例（userId 跟随通道，
      // 模式切换经 BypassManager 激活对应 agent，天然用对隔离池，无需运行时 setUserId）
      channelRegistry.upsertChannel('orchestrator', {
        provider: activeType, model, userId: orchestratorUserId(), thinking: false,
      });
      channelRegistry.setRoleMapping('orchestrator', 'orchestrator');
      channelRegistry.upsertChannel('narration', {
        provider: activeType, model, userId: narrationUserId(), thinking: false,
      });
      channelRegistry.setRoleMapping('narration', 'narration');
    }
  } catch {
    // 通道注册失败不影响主流程
  }

  return {
    channelRegistry,
    modelRouter: results.get('modelRouter') as ModelRouter,
  };
}
