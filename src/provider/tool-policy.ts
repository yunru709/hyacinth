/**
 * 工具调用策略（2026-11-26）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要
 * ────────────────────────────────────────────────────────────────────────────
 * OpenAI / Anthropic / Gemini 三家官方都支持 `tool_choice` 与并行调用控制，
 * 我们此前**一个都没发**。后果：goal / verification 这类"这一步必须产出工具调用"
 * 的场景只能靠提示词约束，软件层没有兜底；也无法在需要严格串行时关掉并行。
 *
 * 官方依据（2026-11-26 代理直取原文）：
 * - OpenAI function-calling.md：`tool_choice: "auto" | "required" | {"type":"function","name":...}`
 *   以及 `parallel_tool_calls: false` 可禁并行；`gpt-4.1-nano-2025-04-14` 开并行可能重复调用同一工具。
 * - Anthropic create.md：`ToolChoice = Auto | Any | Tool | None`，`any`/`tool` 可带
 *   `disable_parallel_tool_use`。
 * - Gemini function-calling.md：`toolConfig.functionCallingConfig.mode = AUTO | ANY | NONE`，
 *   `ANY` + `allowedFunctionNames` 可限定到具体函数。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 安全设计（重要）
 * ────────────────────────────────────────────────────────────────────────────
 * ① **默认不设置 ⇒ 不往请求体塞任何字段** ⇒ 行为与改动前完全一致；
 * ② 由 Provider 的可选 setter 下发（与 `setThinking` / `setMaxOutputTokens` 同模式），
 *    不改 `createStream` 签名 —— 包装类只要转发这一个可选方法即可；
 * ③ 厂商映射是纯函数，可单测，不依赖网络。
 *
 * ⚠️ 新增厂商时：先在这里加映射函数 + 测试，再去 adapter 接线。
 * 不要在 adapter 里各写一遍 if/else（11-08 的教训：漏了不报错）。
 */

/** 统一语义的 tool_choice（跨厂商） */
export type ToolChoice =
  /** 模型自行决定是否调用（缺省行为） */
  | 'auto'
  /** 禁用工具调用 */
  | 'none'
  /**
   * 必须调用至少一个工具。
   * ⚠️ OpenAI 的 `required` 是"至少一个"；Anthropic 的 `any` 也是"至少一个"；
   * Gemini 的 `ANY` 同样是"至少一个" —— 三家语义一致，直接映射。
   */
  | 'required'
  /** 强制调用指定名称的工具（该工具必须在 tools 列表里存在） */
  | { name: string };

/** Provider 级工具策略（可选 setter 的入参） */
export interface ToolPolicy {
  toolChoice?: ToolChoice;
  /** false = 禁止模型一次返回多个工具调用；true/未设置 = 交给厂商默认 */
  parallelToolCalls?: boolean;
}

/** OpenAI Chat Completions 的 tool_choice 形态 */
export type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

/** Anthropic 的 ToolChoice 形态（与官方 SDK 的联合类型结构一致） */
export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'none' }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

/** Gemini 的 toolConfig 形态 */
export interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

/** 统一 → OpenAI 系（openai / compatible / local 共用） */
export function toOpenAIToolChoice(choice: ToolChoice): OpenAIToolChoice {
  if (typeof choice === 'string') {
    // 'auto' | 'none' | 'required' 三家写法一致，直接透传
    return choice;
  }
  return { type: 'function', function: { name: choice.name } };
}

/**
 * 统一 → Anthropic。
 *
 * 并行控制：Anthropic 的 `disable_parallel_tool_use` 挂在 tool_choice 对象上
 * （auto / any / tool 三种都支持；none 本身不调用工具，无需该字段）。
 */
export function toAnthropicToolChoice(
  choice: ToolChoice,
  parallelToolCalls?: boolean,
): AnthropicToolChoice {
  const disableParallel = parallelToolCalls === false ? true : undefined;

  if (typeof choice === 'string') {
    switch (choice) {
      case 'auto':
        return disableParallel
          ? { type: 'auto', disable_parallel_tool_use: true }
          : { type: 'auto' };
      case 'none':
        // none 不涉及并行，忽略 parallelToolCalls
        return { type: 'none' };
      case 'required':
        // Anthropic 没有 required 关键字，语义对应 any（至少调用一个）
        return disableParallel
          ? { type: 'any', disable_parallel_tool_use: true }
          : { type: 'any' };
    }
  }
  return disableParallel
    ? { type: 'tool', name: choice.name, disable_parallel_tool_use: true }
    : { type: 'tool', name: choice.name };
}

/**
 * 统一 → Gemini。
 *
 * - `required` → `ANY`（必须调用至少一个工具）；
 * - `{name}` → `ANY` + `allowedFunctionNames`（限定到具体函数）；
 * - Gemini **没有**并行调用开关，`parallelToolCalls` 在此静默忽略（见注释）。
 */
export function toGeminiToolConfig(choice: ToolChoice): GeminiToolConfig {
  if (typeof choice === 'string') {
    switch (choice) {
      case 'auto':
        return { functionCallingConfig: { mode: 'AUTO' } };
      case 'none':
        return { functionCallingConfig: { mode: 'NONE' } };
      case 'required':
        return { functionCallingConfig: { mode: 'ANY' } };
    }
  }
  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [choice.name],
    },
  };
}
