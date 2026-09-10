import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentDefinition } from '../types.js';
import { createBuiltinAgents } from './builtins.js';
import { loadPrompt } from '../prompts/loader.js';
import type { AgentsConfig } from '../setup/config.js';

/**
 * Agent 配置文件中的单条记录结构
 */
interface AgentConfigEntry {
  name: string;
  description: string;
  promptFile: string;
  allowedTools: string[];
  maxTurns: number;
  modelPreference?: string;
  sessionTtlMinutes?: number;
}

interface AgentsConfigFile {
  agents: AgentConfigEntry[];
}

/**
 * 加载 Agent 配置
 * 
 * 加载顺序：
 * 1. AGENTS_CONFIG_PATH 环境变量（最高优先级）
 * 2. 项目级 .agent/agents.json
 * 3. 全局 ~/.agent/agents.json
 * 4. Fallback: 内置 builtins.ts 定义
 * 
 * 合并策略：后加载的同名 agent 覆盖先加载的
 */
export async function loadAgentConfigs(cwd: string, configOverride?: AgentsConfig): Promise<AgentDefinition[]> {
  // 收集所有 agent 配置（name -> config）
  const agentMap = new Map<string, AgentConfigEntry>();

  // 1. 加载全局 agents.json
  const globalPath = path.join(os.homedir(), '.agent', 'agents.json');
  await loadJsonConfig(globalPath, agentMap);

  // 2. 加载项目级 agents.json（覆盖全局）
  const projectPath = path.join(cwd, '.agent', 'agents.json');
  await loadJsonConfig(projectPath, agentMap);

  // 3. 环境变量覆盖路径（最高优先级）
  const envPath = process.env['AGENTS_CONFIG_PATH'];
  if (envPath) {
    await loadJsonConfig(envPath, agentMap);
  }

  // 4. 如果没有任何配置，fallback 到内置
  if (agentMap.size === 0) {
    return createBuiltinAgents(configOverride);
  }

  // 5. 将配置转为 AgentDefinition
  const agents: AgentDefinition[] = [];
  for (const [name, entry] of agentMap) {
    let systemPrompt: string;
    try {
      systemPrompt = loadPrompt(entry.promptFile);
    } catch {
      // 提示词文件不存在，跳过该 agent
      continue;
    }

    // 应用 configOverride（config.json 中的 agents 覆写）
    const override = configOverride?.[name];

    agents.push({
      name,
      description: entry.description,
      systemPrompt,
      allowedTools: override?.allowedTools ?? entry.allowedTools,
      maxTurns: override?.maxTurns ?? entry.maxTurns,
      modelPreference: entry.modelPreference,
      sessionTtlMinutes: override?.sessionTtlMinutes ?? entry.sessionTtlMinutes,
    });
  }

  return agents;
}

async function loadJsonConfig(filePath: string, agentMap: Map<string, AgentConfigEntry>): Promise<void> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const config: AgentsConfigFile = JSON.parse(content);
    if (Array.isArray(config.agents)) {
      for (const entry of config.agents) {
        agentMap.set(entry.name, entry);
      }
    }
  } catch {
    // 文件不存在或解析失败，忽略
  }
}