/**
 * factory.ts —— Agent 工厂薄壳（行数收尾第十九批：装配主体迁入 agent-assembly.ts）。
 *
 * 本文件只保留对外 API 形状：类型 re-export + createAgent 委托。
 * 装配主体（16 个贡献批/接线模块的编排）见 agent-assembly.ts；
 * 各装配批的实现见同目录 *-contributions.ts / *-wiring.ts 家族。
 *
 * ## 组件装配原则
 *
 * 新增系统级组件（ContextSource / Tool / Flow / 服务）：
 *   1. 新建装配贡献（*-contributions.ts，needs/provides 声明）或在 agent-assembly.ts 接线
 *   2. 工具只通过注册表统一注册（src/tools/runtime-control.ts → createXxxTool() 工厂）
 *   3. 不要在其他地方分散注册——保持单一装配点
 *
 * 提示词、配置均通过外部化体系加载（loadPrompt / RuntimeConfigCenter），
 * 不要在装配中硬编码任何面向模型或用户的文本内容。
 */

import type { LifecycleSupervisor } from '../supervisor/shutdown.js';
import { createAgentAssembly } from './agent-assembly.js';

export type { CreateAgentOptions, AgentComponents } from './agent-assembly.js';
import type { CreateAgentOptions, AgentComponents } from './agent-assembly.js';

/**
 * 创建完整 Agent（类型见 CreateAgentOptions / AgentComponents）。
 * 实际装配在 agent-assembly.ts —— 本文件仅为对外 API 薄壳。
 */
export async function createAgent(
  options: CreateAgentOptions,
  supervisor?: LifecycleSupervisor,
): Promise<AgentComponents> {
  return createAgentAssembly(options, supervisor);
}
