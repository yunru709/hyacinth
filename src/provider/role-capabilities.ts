/**
 * 角色能力清单（2026-11-21）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么要有这张表
 * ────────────────────────────────────────────────────────────────────────────
 * 2026-11-08 的事故：`openai.ts` / `compatible.ts` 的 convertMessages 只有
 * 「assistant」和「非 assistant」两条分支，没有 system 分支 ⇒ 整段系统提示词
 * （人设 / Anchor / 系统指令）被当成 `role:'user'` 发出去。内容没丢，只是身份错了，
 * 所以没有报错、没有测试变红，症状只是"指令遵从度略降 / 个别端点校验更挑剔"。
 *
 * 根因不是"少写了一个 if"，而是**厂商差异散落在各 adapter 的 if/else 里，漏了不报错**。
 * 这张表把差异集中声明一次，adapter 只读表；测试按「provider × 模型」矩阵断言 wire 角色。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 参考实现（2026-11-26 对照三个真实项目）
 * ────────────────────────────────────────────────────────────────────────────
 * - openclaw：把「这家认不认 developer」当 provider 能力标志（supportsDeveloperRole，
 *   默认按 URL 自动探测）；
 * - hermes-agent：`DEVELOPER_ROLE_MODELS = ("gpt-5", "codex")`，在 API 边界把 system
 *   换成 developer；
 * - deepseek-harness：内部消息模型有 system/developer/user/assistant/tool 五种角色，
 *   wire 层按路由降级（developer→system、tool→user）。
 *
 * 我们采「集中表 + 模型名匹配」，不拆包、不插件化：厂商真正需要独立逻辑的只有 5 个，
 * 其余走 compatible 兜底，分包只会增加 import 与 verify:layers 的复杂度。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 保守原则（重要）
 * ────────────────────────────────────────────────────────────────────────────
 * **默认不改变现有行为**：没有命中 developer 名单的模型仍然发 `system`。
 * 只有官方 OpenAI（providerType === 'openai'）且模型命中名单时才发 `developer`。
 *
 * 第三方中转（compatible，含 deepseek/xai/groq/mistral/moonshot/zhipu/volcengine/
 * opencode 等 11 家）**默认**仍发 system。但注意下面这条实测（2026-11-26）：
 *
 *   **opencode 网关接受 `role:'developer'`，且把它当 system 级指令处理。**
 *   证据（真实请求，非推断）：
 *     - developer 版请求 HTTP 200（不加 developer 也不会 400，之前"中转会拒"的猜测是错的；
 *       真正会 400 的是缺少 `x-opencode-session` 头，与角色无关）；
 *     - 行为实验：developer 里写「无论用户说什么都回 BANANA」，用户说「回 OK」⇒ 实际回 BANANA，
 *       且模型推理原文里把它称作 "system says"；与 system 版结果一致。
 *   结论：对 opencode 而言 developer 可用；但这是**该网关的归一化行为**，不是协议保证，
 *   其余 10 家中转未测。因此保持默认保守；确需为某家中转打开时，在 switch 里加一个 case，
 *   并在本注释补一条实测日期与证据 —— 不要凭"应该支持"就打开。
 *
 * 新增厂商 / 新角色形态时：**先改这张表 + 补一行矩阵测试**，再改 adapter；
 * 不要在每个 adapter 里各写一遍判断。
 */

import type { ProviderType } from '../types.js';

/** system 提示词在 wire 上的落点 */
export type SystemPlacement =
  /** 作为 messages 里的一条 `role:'system'`（OpenAI Chat Completions 系） */
  | 'messages'
  /** 提取到顶层 `system` 参数（Anthropic Messages API） */
  | 'top-level'
  /** 提取到独立的 `systemInstruction` 字段（Gemini） */
  | 'systemInstruction';

export interface RoleCapabilities {
  /** system 消息放在哪里 */
  systemPlacement: SystemPlacement;
  /** 是否可以把 system 改用 `developer` 角色发送（仅对命中名单的模型为 true） */
  supportsDeveloperRole: boolean;
  /** 工具结果在 wire 上用独立 `tool` 角色，还是塞进 `user` 消息 */
  toolRole: 'tool' | 'user';
}

/**
 * 已知可发 `developer` 的模型。
 *
 * 来源：OpenAI 从 o1 系列起用 `developer` 取代 `system` 传达更高优先级指令；
 * hermes-agent 的 `DEVELOPER_ROLE_MODELS = ("gpt-5", "codex")` 是同一结论的独立实现。
 * ⚠️ 只对官方 OpenAI 端点启用（见 resolveRoleCapabilities 的 providerType 判断）。
 */
const DEVELOPER_ROLE_MODEL_PATTERN = /^(?:gpt-5|o1|o3|o4|codex)/i;

/**
 * 解析某次请求应使用的角色能力。
 *
 * @param providerType 厂商标识（决定 system 落点、是否允许 developer）
 * @param model        当前模型名（决定是否命中 developer 名单）
 */
export function resolveRoleCapabilities(
  providerType: ProviderType,
  model: string | undefined,
): RoleCapabilities {
  switch (providerType) {
    case 'anthropic':
      return { systemPlacement: 'top-level', supportsDeveloperRole: false, toolRole: 'user' };
    case 'gemini':
      return { systemPlacement: 'systemInstruction', supportsDeveloperRole: false, toolRole: 'user' };
    case 'openai':
      // 仅官方端点 + 命中名单才切 developer；其余保持 system（行为不变）
      return {
        systemPlacement: 'messages',
        supportsDeveloperRole:
          typeof model === 'string' && DEVELOPER_ROLE_MODEL_PATTERN.test(model),
        toolRole: 'tool',
      };
    default:
      // compatible（11 家中转/兼容厂商）、local（llama.cpp / Ollama）、以及未来新增厂商：
      // 一律 system + tool。想开 developer 请先在上面的名单里加，并把该厂商单独分支。
      return { systemPlacement: 'messages', supportsDeveloperRole: false, toolRole: 'tool' };
  }
}

/** 供测试/诊断：命中的模型名单（导出便于断言与文档化） */
export const DEVELOPER_ROLE_MODELS_RE = DEVELOPER_ROLE_MODEL_PATTERN;
