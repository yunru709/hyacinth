/**
 * Thinking（思考模式）的 wire 语义 —— 厂商差异的单一收敛点。
 *
 * 为什么需要它：思考开关长期只认"DeepSeek 官方一种写法"，于是
 *   ① 非 deepseek 厂商一个字段都发不出去（`providerType === 'deepseek'` 白名单兜底）；
 *   ② 发出去的字段被包在 `extra_body` 里 —— 那是 **Python SDK 的参数名**，
 *      Node SDK（本项目 openai@6.x）不认识它，原样透传 ⇒ wire 上变成未知的
 *      `extra_body:{thinking:…}` 嵌套字段，官方读不到（实测确认）；
 *   ③ "关闭"被硬编码为 `thinking:{type:'disabled'}`，而只认 effort 枚举的上游
 *      根本不认这个写法（实测 commandcode：合法枚举是 `off|low|medium|high|xhigh|max`，
 *      发 disabled 时思考照跑），开关等于没有。
 *
 * 本模块把"厂商怎么接线"抽成声明（ThinkingStyle），由 build* 函数产出实际字段。
 * 新增厂商只需声明 style，不再去改开关逻辑本身。
 */

/**
 * 思考模式的接线方式（厂商级 wire 语义）。
 *
 * - `deepseek`  DeepSeek 官方：顶层 `thinking:{type:enabled|disabled}`，
 *               开启时另附顶层 `reasoning_effort`（官方文档：thinking.type 默认 enabled，
 *               必须显式发 disabled 才能关）
 * - `effort`    只认 effort 枚举的中转：只发顶层 `reasoning_effort`，**关闭 = 'off'**
 *               （官方对应值是 `none`，commandcode 实测为 `off`）
 * - `anthropic` Anthropic 原生延长思考：`thinking:{type:'enabled',budget_tokens:N}`，
 *               关闭 = 不发（Anthropic 默认不思考）
 * - `none`      不发任何思考字段（缺省：不往请求体塞未知字段，免得严格网关直接 400）
 */
export type ThinkingStyle = 'deepseek' | 'effort' | 'anthropic' | 'none';

const VALID_STYLES: readonly string[] = ['deepseek', 'effort', 'anthropic', 'none'];

/** effort 型上游的"关闭"取值（commandcode 实测合法枚举之一） */
export const EFFORT_OFF = 'off';

/**
 * 归一化外部输入。
 *
 * providers.json 是用户手写的，style 可能是拼错的字符串 —— 必须回落到
 * undefined（由调用方补缺省 none），而不是抛错或把非法值透传到 wire。
 */
export function normalizeThinkingStyle(value: unknown): ThinkingStyle | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return VALID_STYLES.includes(v) ? (v as ThinkingStyle) : undefined;
}

/**
 * 生成 OpenAI 兼容请求体里的思考字段。
 *
 * ⚠️ 返回值是**顶层**字段，直接 merge 进 body。
 * 不要再包 `extra_body` —— 那是 Python SDK 的参数名，Node SDK 不展开（见文件头②）。
 *
 * @param style   厂商接线方式
 * @param enabled 本轮是否开启思考
 * @param effort  思考强度（仅开启时使用；缺省 'high'，与官方默认一致）
 */
export function buildThinkingParams(
  style: ThinkingStyle,
  enabled: boolean,
  effort?: string,
): Record<string, unknown> {
  switch (style) {
    case 'deepseek':
      return enabled
        ? { thinking: { type: 'enabled' }, reasoning_effort: effort ?? 'high' }
        : { thinking: { type: 'disabled' } };
    case 'effort':
      // 关闭时也**必须发**：上游思考默认开着，不显式发 'off' 就关不掉。
      return { reasoning_effort: enabled ? (effort ?? 'high') : EFFORT_OFF };
    default:
      // 'anthropic'（原生协议，不走这里）与 'none' 在 OpenAI 兼容层不产生字段
      return {};
  }
}

/**
 * 生成 Anthropic 协议请求体的 thinking 字段；关闭 = 不发。
 *
 * 只有声明为 `anthropic` 的厂商才会产出 —— 走 anthropic 兼容端点的其它厂商
 * 若未验证其 thinking 语法，保持缺省（声明 `none`）即可静默不发。
 */
export function buildAnthropicThinking(
  style: ThinkingStyle,
  enabled: boolean,
  budget: number,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (style !== 'anthropic' || !enabled) return undefined;
  return { type: 'enabled', budget_tokens: budget };
}
