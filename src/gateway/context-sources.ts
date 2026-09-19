/**
 * context-sources.ts —— ContextSource 接线抽离（行数收尾 · 接线抽离第一步）。
 *
 * 把 factory 内联的 11 个 contextComposer.registerSource（~200 行）抽为一次
 * 调用 registerContextSources(deps)。依赖（含懒闭包前向引用的 loopRef/loop/
 * toolRegistry 等）经 deps 显式注入，getContent 闭包改为读 deps.xxx。
 *
 * 时序安全：compose 输出由 section-resolver 按 zone/priority 排序，不依赖
 * 注册顺序 —— 全部注册推迟到 deps 就绪点（bundleRegistry 之后）行为等价。
 *
 * 11 个源：env-info / channel_context / flow / memory / companion_memory /
 * session-tools / skill-*（循环）/ agent-*（循环）/ intent_cluster_summary /
 * image_store / tool-bundles。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { LayeredContextComposer } from '../context/composer.js';
import type { MachineRegistry } from '../machine/index.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { SummaryStore } from '../memory/summary.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentLoop } from '../orchestrator/loop.js';
import type { ChannelsInfo } from '../env/index.js';
import { collectSystemInfoAsync, buildEnvironmentSection, type SystemEnvInfo } from '../env/index.js';
import { readScratchpadForContext, ensureScratchpadFile, ensurePathLine } from '../context/scratchpad.js';
import { scratchpadMaxChars } from '../context/context-config.js';
// companion_memory 现按「当前 loop 的 activeRouter」判定，不再需要全局 getActiveRouter

export interface ContextSourceDeps {
  contextComposer: LayeredContextComposer;
  cwd: string;
  sessionDir: string;
  channelsInfo: ChannelsInfo[] | undefined;
  envInfo: Promise<SystemEnvInfo>;
  currentChannel: string | undefined;
  currentSessionIdForCtx: string;
  flowRegistry: MachineRegistry;
  memoryStore: MemoryStore;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  summaryStore: SummaryStore;
  /** 懒闭包前向引用：intent_cluster_summary 运行时经 loopRef 读当前意图能力 */
  loopRefBox: { current: AgentLoop | null };
  loop: AgentLoop;
  bundleRegistry: ToolBundleRegistry;
}

/**
 * 注册全部内置 ContextSource（原 factory 内联 11 块）。
 * 需在 loopRef / loop / bundleRegistry 全部就绪后调用（行为等价，见文件头）。
 */
export function registerContextSources(deps: ContextSourceDeps): void {
  const { contextComposer, cwd, channelsInfo, flowRegistry, memoryStore, toolRegistry, skillRegistry, agentRegistry, sessionDir, summaryStore, loopRefBox, loop, bundleRegistry } = deps;

  // ── 环境信息采集（进程启动时执行一次，注册为 ContextSource） ────────
  contextComposer.registerSource({
    name: 'env-info',
    strategy: 'always_inline',
    cacheability: 'anchor',
    description: '运行环境信息（静态模板 + 动态系统信息 + 渠道信息）',
    getContent: async () => buildEnvironmentSection(await deps.envInfo, deps.channelsInfo ?? [], { cwd }),
  });

  // ── 渠道上下文（告诉模型当前在哪个渠道、哪个 session） ──────────────
  contextComposer.registerSource({
    name: 'channel_context',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '当前渠道和会话上下文',
    getContent: () => {
      if (!deps.currentChannel) return '';
      return `You are currently communicating via **${deps.currentChannel}** channel (session: ${deps.currentSessionIdForCtx.slice(0, 20)}...).`;
    },
  });

  // ── Flow 注入（Zone 5 flow_injection section）─────────────────────
  // 由 MachineRegistry.getContextInjection() 统一提供：
  //   - 活跃 Flow：注入当前步骤提示词（渐进式披露——每轮只暴露当前一步）
  //   - Flow 刚完成：注入一条完成通知，让模型感知「flow 已终结」，避免反复调用 flow_complete
  contextComposer.registerSource({
    name: 'flow',
    strategy: 'always_inline',
    cacheability: 'live',
    description: 'Flow 步骤注入（当前活跃 Flow 的步骤提示词；终结后注入完成通知）',
    getContent: () => flowRegistry.getContextInjection(),
  });

  // ── 跨会话 Memory 系统 ─────────────────────────────────────────────
  contextComposer.registerSource({
    name: 'memory',
    strategy: 'always_inline',
    cacheability: 'manifest',
    description: '跨会话项目记忆',
    getContent: () => memoryStore.formatForContext(),
  });

  // 首次启用：把预置内容落到磁盘（内含"这个记事本在哪、怎么用"的说明 ✓，幂等 ✓）
  ensureScratchpadFile();
  // 每次启动校正**第一行**（路径是运行期推导的 ⇒ 换机器/换用户名后自动跟上；已正确则不写盘 ✓）
  ensurePathLine();

  // ── 临时记事本（Zone 5）──────────────────────────────────────────────
  // 用户裁定（2026-09-19）：进 **Zone 5**、位置在**时间戳之后**；**不进消息流转**
  // （Zone 5 是每轮变化的 live 尾巴，不写历史 ⇒ 不会像消息那样把上下文堆满记事本）。
  // 文件与 memory 同目录（~/.agent/prompts/persona/scratchpad.md），可直接用 edit 工具改。
  // 现读现注入（同一轮内改完即生效）—— 与 companion_memory 的做法一致。
  contextComposer.registerSource({
    name: 'scratchpad',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '临时记事本（Zone 5；不进消息流转，与 memory 同目录）',
    getContent: () => readScratchpadForContext(scratchpadMaxChars()),
  });

  // ── 陪伴模式 Memory ──────────────────────────────────────────────────
  // 从角色目录动态读取（~/.agent/companion/<name>/memory.md），
  // 不同角色各自独立的记忆文件。
  contextComposer.registerSource({
    name: 'companion_memory',
    strategy: 'always_inline',
    cacheability: 'manifest',
    description: '陪伴模式专属记忆（按角色隔离）',
    getContent: () => {
      // 渠道级：读取**当前 loop** 的 Router —— 只有该 loop 处于陪伴模式时才注入角色记忆，
      // 避免某个渠道进入陪伴后把角色记忆泄漏到其它渠道的上下文。
      const router = (deps.loop as unknown as {
        activeRouter?: { name?: string; activeCompanionName?: string };
      }).activeRouter;
      const name = router?.name === 'companion' ? router.activeCompanionName : '';
      if (typeof name !== 'string' || !name) return '';
      const file = path.join(os.homedir(), '.agent', 'companion', name, 'memory.md');
      try {
        const content = fs.readFileSync(file, 'utf-8');
        return content.trim()
          ? `<!-- 陪伴角色记忆（${name}）-->\n\n${content}`
          : '';
      } catch {
        return ''; // 文件不存在，无记忆
      }
    },
  });

  // ── 会话临时工具 ContextSource ──────────────────────────────────────
  // hot-reload 热添加的工具不进 Zone 2 tool_rules，在此 Zone 5 session_tools 展示。
  // 下次启动时工具已在 ToolRegistry 中持久化，自然归位到 tool_rules。
  contextComposer.registerSource({
    name: 'session-tools',
    strategy: 'index_only',
    cacheability: 'live',
    description: '会话临时工具',
    getContent: () => {
      const names = toolRegistry.getHotAddedNames();
      return names.length > 0 ? `[Hot-added tools (session-scoped, additional to standard tools)]\n${names.join(', ')}` : '';
    },
  });

  // ── 每个 Skill 为独立的 lazy_expand 源 ─────────────────────────────
  for (const skill of skillRegistry.getAll()) {
    contextComposer.registerSource({
      name: `skill-${skill.name}`,
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: skill.description,
      getContent: () => skillRegistry.getFullDefinitions([skill.name]),
    });
  }

  // ── 每个子 Agent 为独立的 lazy_expand 源 ───────────────────────────
  for (const agent of agentRegistry.getAll()) {
    contextComposer.registerSource({
      name: `agent-${agent.name}`,
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: agent.description,
      getContent: () => agentRegistry.getFullDefinitions([agent.name]),
    });
  }

  // ── 意图簇摘要注册源（Zone 3 history_summary 的数据来源）──
  // 按 orchestrator 当前识别的意图读取对应簇的压缩摘要；无意图或无可读摘要时返回空串，
  // section-resolver 会回退到全局 summary（旧策略）。
  contextComposer.registerSource({
    name: 'intent_cluster_summary',
    strategy: 'always_inline',
    cacheability: 'summarized',
    description: '当前意图簇的压缩摘要（按 orchestrator 识别的意图读取）',
    getContent: async () => {
      const cap = loopRefBox.current?.getCurrentIntentCapability?.() ?? 'general';
      if (!cap || cap === 'general') return '';
      // 修复 key 不匹配 bug：写入端摘要文件以 cluster_id 命名（cluster_{clusterId}.md，
      // 如 channel_config），而非 capability（coding）。故不能直接用 load(sessionDir, cap)，
      // 必须先从 cluster-index.json 聚合该 capability 对应的全部 cluster_id，再逐个读取合并。
      try {
        const indexPath = path.join(sessionDir, 'cluster-index.json');
        if (!fs.existsSync(indexPath)) return '';
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const clusters: Array<{ cluster_id: string; capability: string; summary: string }> =
          JSON.parse(raw);
        const matches = clusters.filter((c) => c.capability === cap);
        if (matches.length === 0) return '';
        const parts: string[] = [];
        for (const c of matches) {
          const s = await summaryStore.load(sessionDir, c.cluster_id);
          if (s) parts.push(s);
        }
        return parts.length > 0 ? parts.join('\n\n') : '';
      } catch {
        return '';
      }
    },
  });

  // ── ImageStore 上下文注入 — 让模型始终知道已索引的图片 ──────────
  contextComposer.registerSource({
    name: 'image_store',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '已索引图片清单（通过 view_image 工具可重新查看）',
    getContent: () => loop.imageStore.listForContext(),
  });

  // ── Tool Bundle 上下文（Zone 1 tool_bundles section）──
  // 上下文注册链路：
  //   manifest-defaults.ts Zone 1 → tool_bundles section (runtime:tool_bundles)
  //     → section-resolver.ts resolveRuntime() → ctx.sources.get('tool-bundles')
  //       → 本文件（ContextSource 注册，getContent 闭包）
  //         → src/tools/bundle-registry.ts (ToolBundleRegistry，持久化到 ~/.agent/tool-bundles.json)
  // 工具过滤链路：
  //   loop.ts runTurn() → bundleRegistry.getActiveToolNames() → 过滤 toolDefinitions
  contextComposer.registerSource({
    name: 'tool-bundles',
    strategy: 'always_inline',
    cacheability: 'manifest',
    description: '工具包索引',
    getContent: () => {
      const bundles = bundleRegistry.list();
      if (bundles.length === 0) return '';
      const activeNames = new Set(bundleRegistry.getActive().map(b => b.name));
      const lines = bundles.map(b => {
        let marker = '';
        if (b.name === 'common') {
          marker = ' [始终加载]';
        } else if (activeNames.has(b.name)) {
          marker = ' [已激活]';
        }
        const toolCount = b.tools.length > 0 ? ` (${b.tools.length} tools)` : ' (全量)';
        return `- ${b.name}: ${b.description}${toolCount}${marker}`;
      });
      const statusLine = bundleRegistry.isAllMode()
        ? '当前状态: 全量模式 — 所有工具均可用'
        : `当前激活: ${[...activeNames].join(', ')}`;
      return `${statusLine}\n\n${lines.join('\n')}`;
    },
  });
}
