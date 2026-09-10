import type { AgentDefinition } from '../types.js';
import type { AgentsConfig } from '../setup/config.js';
import { loadPrompt } from '../prompts/loader.js';

/**
 * 创建内置子 Agent 定义（fallback 用）
 * @param config 可选的 Agent 配置覆写，用于覆盖默认的 maxTurns、allowedTools
 */
export function createBuiltinAgents(config?: AgentsConfig): AgentDefinition[] {
  const defaults: AgentDefinition[] = [
    {
      name: 'code-reviewer',
      description: '代码审查专家，审查代码质量、可读性和最佳实践',
      systemPrompt: loadPrompt('agents/code-reviewer'),
      allowedTools: ['read', 'glob', 'grep'],
      maxTurns: 10,
      sessionTtlMinutes: 10,
    },
    {
      name: 'security-auditor',
      description: '安全审计专家，检查代码中的安全漏洞和风险',
      systemPrompt: loadPrompt('agents/security-auditor'),
      allowedTools: ['read', 'glob', 'grep'],
      maxTurns: 10,
      sessionTtlMinutes: 10,
    },
    {
      name: 'test-writer',
      description: '测试编写专家，为代码编写单元测试和集成测试',
      systemPrompt: loadPrompt('agents/test-writer'),
      allowedTools: ['read', 'write', 'glob', 'grep', 'bash'],
      maxTurns: 15,
      sessionTtlMinutes: 10,
    },
  ];

  return defaults.map((agent) => {
    const override = config?.[agent.name];
    if (!override) return agent;

    const merged = { ...agent };
    if (override.maxTurns !== undefined) merged.maxTurns = override.maxTurns;
    if (override.allowedTools !== undefined) merged.allowedTools = override.allowedTools;

    return merged;
  });
}