/**
 * core-contributions.ts —— 核心服务贡献批（行数收尾第三批 · P-B 第一小批）。
 *
 * 迁移 P-B 中「创建集中、无接线交织、依赖链可表达」的一簇：
 * 存储四件套（ConversationStore/EventStore/StatsManager/SummaryStore）+
 * skillRegistry + skillTool（依赖 skillRegistry，拓扑保证先建）。
 *
 * 其余 P-B 类（contextComposer/toolRegistry/compressor 链/mcpSystem 等）与
 * 11 个 ContextSource 注册、工具注册深度交织，且 getContent 多为懒闭包前向
 * 引用 —— 需先做「接线抽离」才能外移（见行数收尾难度地图，属后续长线）。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { ConversationStore } from '../memory/conversation.js';
import { EventStore } from '../memory/events.js';
import { StatsManager } from '../memory/stats.js';
import { SummaryStore } from '../memory/summary.js';
import { SkillRegistry, SkillTool } from '../skills/index.js';

export interface CoreContributionDeps {
  maxMessages: number;
}

/** 执行核心服务贡献批（stores ×4 + skillRegistry + skillTool），返回产出供 factory 解构 */
export async function runCoreContributions(
  deps: CoreContributionDeps,
): Promise<AssemblyResults> {
  const runner = new AssemblyRunner();
  runner.provide('maxMessages', deps.maxMessages);
  return runner.run([
    {
      id: 'stores',
      needs: ['maxMessages'],
      provides: ['conversationStore', 'eventStore', 'statsManager', 'summaryStore'],
      mount: ({ maxMessages }) => ({
        conversationStore: new ConversationStore(maxMessages as number),
        eventStore: new EventStore(),
        statsManager: new StatsManager(),
        summaryStore: new SummaryStore(),
      }),
    },
    {
      id: 'skillRegistry',
      needs: [],
      provides: ['skillRegistry'],
      mount: () => ({ skillRegistry: new SkillRegistry() }),
    },
    {
      id: 'skillTool',
      needs: ['skillRegistry'],
      provides: ['skillTool'],
      mount: ({ skillRegistry }) => ({
        skillTool: new SkillTool(skillRegistry as SkillRegistry),
      }),
    },
  ]);
}
