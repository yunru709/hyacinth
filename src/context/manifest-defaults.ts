/**
 * 默认上下文清单（Context Manifest）。
 *
 * 可通过 `.agent/context-manifest.json` 覆盖。
 *
 * Zone 布局规范：
 *   Zone 1 (Anchor)   — 身份 / 人设 / 环境 / 框架能力 / 工具规则 / 注册表 / 记忆 / 注意
 *                        装入稳定、极少变动的内容，享受前缀缓存。
 *   Zone 2 (Manifest) — 辅助索引区，默认关闭
 *                        供需要独立缓存断点的 Provider 使用。
 *   Zone 3 (History)  — 压缩摘要 / 项目上下文 / 对话历史
 *                        内容随对话增长，由压缩器管理边界。
 *   Zone 4 (Context)  — 知识库检索结果（可独立开关）
 *                        外部知识注入区，用户可在 config 中关闭以节省 tokens。
 *   Zone 5 (Live)     — 工作流注入 / 时间戳 / 用户输入 / 会话临时工具
 *                        每轮都会变化的内容，不适合缓存。
 */

import type { ContextManifest } from './manifest-types.js';

export const DEFAULT_CONTEXT_MANIFEST: ContextManifest = {
  version: 1,
  zones: {
    // ── Zone 1: Anchor ──────────────────────────────────────────────
    // 身份/人设、环境、框架能力、工具规则、Skill/Agent/MCP 注册表、记忆
    // 最稳定的内容层，享受前缀缓存。变更需重启或热重载触发重算。
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
        // ── 工具 / Skill / Agent / MCP 注册表 ──
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

    // ── Zone 2: Manifest ────────────────────────────────────────────
    // 辅助索引区，默认关闭。供需要独立构建缓存断点的 Provider 使用。
    zone2: {
      name: 'Manifest',
      order: 2,
      enabled: false,
      sections: [],
    },

    // ── Zone 3: History ─────────────────────────────────────────────
    // 压缩摘要、项目上下文文件、对话历史消息。
    // 唯一的持续增长区，由压缩器按阈值管理。
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

    // ── Zone 4: Context ─────────────────────────────────────────────
    // 知识库检索结果（可独立开关）。
    // 外部知识注入层，用户可通过 hotReload.watchContextManifest 或直接
    // 编辑 .agent/context-manifest.json 关闭此 Zone 以节省 tokens。
    zone4: {
      name: 'Context',
      order: 4,
      enabled: true,
      sections: [
        { name: 'kb_context', source: 'runtime:kb_context', priority: 0, type: 'runtime', description: '知识库检索结果' },
      ],
    },

    // ── Zone 5: Live ───────────────────────────────────────────────
    // 每轮都可能变化的内容：工作流注入、时间戳、用户输入、会话临时工具等。
    // 不适合前缀缓存，始终实时计算。
    zone5: {
      name: 'Live',
      order: 5,
      enabled: true,
      sections: [
        { name: 'workflow_persistent', source: 'runtime:workflow-persistent', priority: 0, type: 'runtime', description: '当前工作流持久上下文（分析/引导，阶段切换时变化）' },
        { name: 'workflow_step',       source: 'runtime:workflow-step',       priority: 1, type: 'runtime', description: '当前工作流步骤指令（每步变化）' },
        { name: 'session_mcp',        source: 'runtime:mcp_live',           priority: 2, type: 'runtime', description: '会话中热插拔的 MCP 工具索引' },
        { name: 'session_tools',      source: 'runtime:tools_live',         priority: 4, type: 'runtime', description: '会话中热插拔的工具' },
        { name: 'timestamp',          source: 'runtime:timestamp',          priority: 5, type: 'runtime', description: '当前时间戳' },
        { name: 'user_input',         source: 'runtime:userInput',          priority: 6, type: 'runtime', description: '用户当前输入（每轮变化）' },
      ],
    },
  },
};
