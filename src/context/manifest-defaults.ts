/**
 * 默认上下文清单（Context Manifest）。
 *
 * 可通过 `.agent/context-manifest.json` 覆盖。
 *
 * ── 加载链 ──────────────────────────────────────────────
 * ManifestLoader (src/context/manifest-loader.ts)
 *   → {cwd}/.agent/context-manifest.json    ← 项目级覆盖（优先）
 *   → manifest-defaults.ts                  ← 本文件（兜底默认）
 *
 * 修改上下文布局时：
 *   1. 改本文件的 section 定义 → 影响所有未覆盖的项目
 *   2. 改 .agent/context-manifest.json → 仅影响当前项目
 *   3. 新增 prompt 文件 → 放在 src/prompts/ 下，由 loadPrompt() 加载
 *      （加载优先级：.agent/prompts/ > ~/.agent/prompts/ > dist/prompts/）
 *
 * ── Section 类型说明 ─────────────────────────────────────
 *   static     — 直接加载 prompt 文件，每次 compose 注入
 *   runtime    — 由 section-resolver.ts 的 resolveRuntime() 动态生成
 *   retrieval  — 检索型（如知识库、项目上下文），按需拉取
 *   conditional — 满足 condition 时才注入（如 precise_mode）
 *   template   — 含 {{变量}}，由 resolveTemplate() 渲染
 *
 * ── 各 Section 的注册位置索引 ───────────────────────────
 *   persona_soul  → src/prompts/persona/ (SOUL.md, IDENTITY.md, USER.md)
 *   tool_rules    → src/prompts/tools/tool-rules.md
 *   tool_bundles  → src/gateway/factory.ts (ContextSource 注册)
 *                  + src/tools/bundle-registry.ts (ToolBundleRegistry)
 *   skills        → ContextSource 'skill-*' (index_only, factory.ts 注册)
 *   agents        → ContextSource 'agent-*' (index_only, factory.ts 注册)
 *   mcp           → ContextSource 'mcp-*' (index_only, factory.ts 注册)
 *   memory        → ContextSource 'memory' (factory.ts 注册)
 *                  + src/memory/store.ts (MemoryStore)
 *   timestamp     → section-resolver.ts resolveRuntime('runtime:timestamp')
 *   user_input    → section-resolver.ts resolveRuntime('runtime:userInput')
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
 *
 * ══ 与 Composer 的关系 ══
 * 本文件是"菜单"——定义有什么 section、放哪个 zone、什么类型。
 * composer.ts 是"厨师"——读取本定义，按 zone 遍历 section，调用
 * section-resolver.ts 解析内容，最终组装成 Message[]。
 *
 * 新增一个 section 只需在此文件的对应 zone 中添加一个 SectionEntry。
 * Composer 会在下次 compose 时自动纳入。无需改 composer 代码。
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
        // { name: 'environment',             source: 'runtime:env',                   priority: 10, type: 'runtime',    description: '运行环境信息 → 已迁移为 system_info / channel_info 工具' },
        // framework_capabilities 已移除（2026-07-10）：工具描述已通过 API tools 字段提供，
        // TUI 斜杠命令（/session、/channel 等）不应进入 LLM 上下文，避免引发模型幻觉。
        // { name: 'framework_capabilities',  source: 'prompts/framework-capabilities', priority: 15, type: 'static' },
        // ── 工具 / Skill / Agent / MCP 注册表 ──
        // tool-rules.md → 模型工具使用规范。内容在 src/prompts/tools/tool-rules.md
        { name: 'tool_rules',    source: 'prompts/tool-rules',   priority: 20, type: 'static',  description: '工具使用规则' },
        // tool_bundles → ContextSource 注册在 src/gateway/factory.ts，数据源在 src/tools/bundle-registry.ts
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
        // pool_context：全量存档关键词召回（压缩-存档-召回闭环的最后一根线）。
        // 仅当工作历史达到 context.poolMinHistory（默认 200）条时才读存档检索，
        // 预算 4%（zone4BudgetRatio），补回压缩丢掉的细节。
        { name: 'pool_context',     source: 'runtime:pool',           priority: 2, type: 'retrieval', description: '全量存档关键词召回（长会话才启用）' },
        { name: 'history',          source: 'runtime:history',        priority: 3, type: 'runtime',  description: '对话历史消息（含边界标记）' },
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
        { name: 'flow_injection',     source: 'runtime:flow',               priority: 1, type: 'runtime', description: 'Flow 步骤注入（bootstrap/TODO/plan 等）' },
        { name: 'channel_context',    source: 'runtime:channel_context',    priority: 2, type: 'runtime', description: '当前渠道和会话上下文' },
        { name: 'session_mcp',        source: 'runtime:mcp_live',           priority: 3, type: 'runtime', description: '会话中热插拔的 MCP 工具索引' },
        { name: 'session_tools',      source: 'runtime:tools_live',         priority: 4, type: 'runtime', description: '会话中热插拔的工具' },
        { name: 'orchestrator_hint',   source: 'runtime:orchestrator_hint',  priority: 5, type: 'runtime', description: '旁路Agent注入（意图/约束/纠正）' },
        { name: 'timestamp',          source: 'runtime:timestamp',          priority: 6, type: 'runtime', description: '当前时间戳' },
        { name: 'user_input',         source: 'runtime:userInput',          priority: 7, type: 'runtime', description: '用户当前输入（每轮变化）' },
      ],
    },
  },
};
