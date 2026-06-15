import type { ContextManifest } from './manifest-types.js';

export const DEFAULT_CONTEXT_MANIFEST: ContextManifest = {
  version: 1,
  zones: {
    zone1: {
      name: 'Anchor',
      order: 1,
      enabled: true,
      role: 'system',
      sections: [
        // ── 核心身份 ──
        { name: 'persona_precise',         source: 'prompts/precise/persona',       priority: 0,  type: 'conditional', condition: 'precise_mode', description: '精确模式约束（替代 persona）' },
        { name: 'persona_soul',            source: 'prompts/persona',               priority: 1,  type: 'static',     description: '用户 persona（SOUL/IDENTITY/USER）' },
        { name: 'environment',             source: 'runtime:env',                   priority: 10, type: 'runtime',    description: '运行环境信息' },
        { name: 'framework_capabilities',  source: 'prompts/framework-capabilities', priority: 15, type: 'static' },
        // ── 工具 / Skill / Agent / MCP 注册表（原 Zone 2）─
        { name: 'tool_rules',    source: 'prompts/tool-rules',   priority: 20, type: 'static',  description: '工具使用规则' },
        { name: 'tool_bundles',  source: 'runtime:tool_bundles', priority: 21, type: 'runtime', description: '工具包索引' },
        { name: 'skills',        source: 'runtime:skills',       priority: 22, type: 'runtime', description: 'Skill 注册表内容' },
        { name: 'agents',        source: 'runtime:agents',       priority: 23, type: 'runtime', description: '子 Agent 注册表内容' },
        { name: 'mcp',           source: 'runtime:mcp',          priority: 24, type: 'runtime', description: 'MCP 工具注册表内容' },
        { name: 'memory',        source: 'runtime:memory',       priority: 25, type: 'runtime', description: '跨会话项目记忆' },
        // ── 尾部注意 ──
        { name: 'attention',              source: 'prompts/attention',              priority: 30, type: 'static' },
      ],
    },
    zone2: {
      name: 'Manifest',
      order: 2,
      enabled: false,
      sections: [],
    },
    zone3: {
      name: 'History',
      order: 3,
      enabled: true,
      sections: [
        { name: 'project_context', source: 'runtime:projectContext', priority: 0, type: 'retrieval', description: '项目上下文文件 (.agent.md / AGENTS.md / CLAUDE.md)' },
        { name: 'history_summary',  source: 'runtime:summary',        priority: 1, type: 'runtime',  description: '上下文压缩摘要' },
        { name: 'history_boundary_before', source: 'runtime:history_boundary_before', priority: 2, type: 'runtime', role: 'system', description: '历史对话开始标记' },
        { name: 'history',          source: 'runtime:history',        priority: 3, type: 'runtime',  description: '对话历史消息' },
        { name: 'history_boundary_after',  source: 'runtime:history_boundary_after',  priority: 4, type: 'runtime', role: 'system', description: '历史对话结束标记' },
      ],
    },
    zone4: {
      name: 'Context',
      order: 4,
      enabled: true,
      sections: [
        { name: 'kb_context', source: 'runtime:kb_context', priority: 0, type: 'runtime', description: '知识库检索结果' },
      ],
    },
    zone5: {
      name: 'Live',
      order: 5,
      enabled: true,
      sections: [
        { name: 'mode_injection',     source: 'runtime:mode_injection',     priority: 1, type: 'runtime', description: 'plan/spec 模式激活时注入的提示词' },
        { name: 'session_mcp',        source: 'runtime:mcp_live',           priority: 2, type: 'runtime', description: '会话中热插拔的 MCP 工具索引' },
        { name: 'session_tools',      source: 'runtime:tools_live',         priority: 4, type: 'runtime', description: '会话中热插拔的工具' },
        { name: 'timestamp',          source: 'runtime:timestamp',          priority: 5, type: 'runtime', description: '当前时间戳' },
        { name: 'user_input',         source: 'runtime:userInput',          priority: 6, type: 'runtime', description: '用户当前输入（每轮变化）' },
      ],
    },
  },
};
