/**
 * world-engine-service.ts —— 世界引擎能力服务（world-engine.createAgent）。
 *
 * 内核只供**轻量能力引用**（世界引擎工厂），不 mount 任何世界引擎插件：
 * 实际的世界引擎 agent 由 companion 目录插件经此工厂创建/注册/激活（插件驱动）。
 * 实现类 WorldEngine 留在内核库（src/world-engine/agent.ts），装配主体不直接 new。
 *
 * 抽为独立模块（同 context-mode-service.ts），满足装配守卫 B：
 * 装配主体（agent-assembly）只调工厂函数，不直接 new 业务类。
 */
import { WorldEngine } from '../world-engine/agent.js';

/** 世界引擎工厂：角色名 → WorldEngine 实例（供目录插件/CompanionRouter 创建世界） */
export function createWorldEngineFactory(): (name: string) => WorldEngine {
  return (name: string) => new WorldEngine(name);
}
