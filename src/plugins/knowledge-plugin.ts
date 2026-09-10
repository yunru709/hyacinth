/**
 * 知识库插件（P3 第一个功能插件示范）—— 把知识库从 factory 硬编码装配迁为插件注册。
 *
 * 原为 gateway/factory.ts 的 ~75 行内联装配：KnowledgeBase + StructuredStore +
 * kb_context ContextSource + 5 个工具 + 懒启动 watcher。
 * 插件化后：
 * - 模块留在 src/knowledge/（引擎本身不动），本文件提供 HyPlugin 包装
 * - activate 时经 ctx.registerTool / ctx.registerContextSource 注册能力，
 *   卸载自动回滚（工具注销 + ContextSource 注销 + watcher 停止）
 * - 配置经 mount 第二参（configs 或 mount 时传入）：{ enabled, zone4 }
 * - 与工厂内联装配行为等价：config 持久化状态恢复、Zone 4 条件、懒 watcher
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { HyPlugin, PluginContext } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { ContextComposerLike } from '../context/interface.js';
import {
  KnowledgeBase,
  KnowledgeWatcher,
  StructuredStore,
  createKbAddTool,
  createKbListTool,
  createKbDeleteTool,
  createKbUpdateTool,
  createKbToggleTool,
  createStructuredTool,
} from '../knowledge/index.js';

export const KNOWLEDGE_PLUGIN_ID = 'knowledge';

export interface KnowledgePluginConfig {
  /** 是否启用知识库（默认跟随 kb.enabled 配置） */
  enabled?: boolean;
  /** 是否启用 Zone 4（默认跟随 kb.zone4 配置） */
  zone4?: boolean;
  /** 知识库根目录（默认 ~/.agent/knowledge） */
  kbDir?: string;
}

/** 插件依赖的内核服务（经 ctx.register 注册的 key） */
export interface KnowledgePluginServices {
  configCenter?: RuntimeConfigCenter;
  contextComposer: ContextComposerLike;
}

/** 知识库插件对外暴露的服务句柄（factory 取回供上层消费；§5.2 收窄：删永远为 null 的 kbWatcher 死字段） */
export interface KnowledgeApi {
  knowledgeBase: KnowledgeBase;
  kbState: { lastQuery: string };
  getStructuredStore: () => StructuredStore;
  getWatcher: () => KnowledgeWatcher;
}

/** knowledge 插件在宿主中注册的服务键（factory 经 host.get 取回） */
export const KNOWLEDGE_API_KEY = 'knowledge.api';

export function createKnowledgePlugin(
  services: KnowledgePluginServices,
): HyPlugin<Record<string, unknown>, LoopHooks> {
  return {
    id: KNOWLEDGE_PLUGIN_ID,

    async activate(ctx: PluginContext<Record<string, unknown>, LoopHooks>, rawConfig) {
      const config = (rawConfig ?? {}) as KnowledgePluginConfig;
      const kbDir = config.kbDir ?? path.join(os.homedir(), '.agent', 'knowledge');
      const kbStorePath = path.join(kbDir, 'kb.sqlite');
      const kbFilesDir = path.join(kbDir, 'files');
      fs.mkdirSync(kbFilesDir, { recursive: true });

      const configCenter = services.configCenter;
      const contextComposer = services.contextComposer;

      // 引擎实例（随插件生命周期；卸载时无需显式销毁，sqlite 连接由 GC/关闭处理）
      const knowledgeBase = new KnowledgeBase(kbStorePath);
      const kbState = { lastQuery: '' };

      // 结构化存储 — 懒创建（不启用知识库时不建表，避免额外开销，与原工厂行为一致）
      let _structuredStore: StructuredStore | null = null;
      const getStructuredStore = (): StructuredStore => {
        if (!_structuredStore) {
          _structuredStore = new StructuredStore(kbStorePath);
        }
        return _structuredStore;
      };

      // 从 config 恢复 KB/Zone4 状态（持久化）
      const wantEnabled = config.enabled ?? configCenter?.get<boolean>('kb.enabled') ?? false;
      const wantZone4 = config.zone4 ?? configCenter?.get<boolean>('kb.zone4') ?? false;
      if (wantEnabled) knowledgeBase.enable();
      if (wantZone4) {
        knowledgeBase.setZone4Enabled(true);
        contextComposer.activeConditions.add('zone4_enabled');
      }

      // Zone 4 ContextSource（结构化 tag 匹配 + FTS5 兜底）
      const kbSource: import('../context/interface.js').ContextSource = {
        name: 'kb_context',
        strategy: 'always_inline',
        cacheability: 'live',
        description: '知识库检索结果',
        getContent: async () => {
          if (!knowledgeBase.enabled) return '';
          const q = kbState.lastQuery;
          if (!q || !q.trim()) return '';
          const maxTotal = configCenter?.get<number>('kb.maxTotal') ?? 5;
          const maxMain = configCenter?.get<number>('kb.maxMain') ?? 3;
          const maxRefs = configCenter?.get<number>('kb.maxRefs') ?? 2;
          const ss = getStructuredStore();
          return ss.formatResults(
            ss.search(q, maxTotal),
            maxMain,
            maxRefs,
          );
        },
      };
      ctx.registerContextSource(kbSource);

      // 知识库工具（5 + 结构化 4 合 1）
      ctx.registerTool(createKbToggleTool(knowledgeBase, contextComposer));
      ctx.registerTool(createStructuredTool(getStructuredStore, () => knowledgeBase.enabled));
      ctx.registerTool(createKbAddTool(knowledgeBase, kbFilesDir));
      ctx.registerTool(createKbListTool(knowledgeBase));
      ctx.registerTool(createKbDeleteTool(knowledgeBase, kbFilesDir));
      ctx.registerTool(createKbUpdateTool(knowledgeBase, kbFilesDir));

      // 知识库文件监控（后台自动索引 files/ 目录变更）— 懒启动
      let watcher: KnowledgeWatcher | null = null;
      const startWatcher = (): KnowledgeWatcher => {
        if (!watcher) {
          watcher = new KnowledgeWatcher({
            filesDir: kbFilesDir,
            retriever: knowledgeBase.retriever,
          });
          watcher.start().catch(() => {});
        }
        return watcher;
      };

      // 插件内登记资源：卸载时停止 watcher（disposer 自动执行）
      ctx.add({
        dispose: () => { watcher?.stop?.().catch?.(() => {}); watcher = null; },
      });

      // 对外服务句柄：factory 经 host.get('knowledge.api') 取回，供协议层 kb 域等消费
      // （http-webhook / ui-protocol / tui 仍按 AgentComponents.knowledgeBase 等字段访问）
      ctx.register(KNOWLEDGE_API_KEY, {
        knowledgeBase,
        kbState,
        getStructuredStore,
        getWatcher: startWatcher,
      } satisfies KnowledgeApi);

      ctx.logger.info('knowledge plugin activated', {
        enabled: knowledgeBase.enabled,
        zone4: knowledgeBase.zone4Enabled,
        dir: kbDir,
      });
    },
  };
}
