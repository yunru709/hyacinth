/**
 * Where → 会话唤醒适配器（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 这个模块存在的唯一理由：`Where` 有两种语义，落地方式完全不同
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   reuse —— 在**指定会话**里跑，加载它的完整历史。
 *            "在那条对话里接着上次说"，模型能综合之前的信息判断。
 *            落地：port.runPrompt(channel, sessionId, prompt)
 *
 *   new   —— 开一个**干净的一次性会话**，只有触发事件本身。
 *            "就事论事，别被历史结论带偏"，跑完即焚。
 *            落地：port.runPromptInNewSession({ channel, prompt, deliverSessionId, ttlMs })
 *
 * ⚠️ 两者绝不能混用，用错会毁掉效果：
 *      需要连续上下文的任务用 new  ⇒ 模型失忆
 *      需要客观判断的任务用 reuse ⇒ 模型被旧结论带偏
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么端口是**注入**而不是 import
 * ────────────────────────────────────────────────────────────────────────────
 * automation 是新的业务层，不该直接认识 schedule 的端口类型
 * （否则 verify:layers 会报跨层，且两个业务核心互相牵扯）。
 * 由装配层把 `SchedulerSessionPort` 传进来，本模块只认它需要的那两个方法。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 失败语义（重要）
 * ────────────────────────────────────────────────────────────────────────────
 * 端口未实现 / 未被调用方实现时 **抛错**，绝不静默假装跑过。
 * 理由：链路写的是"唤醒会话深入处理"，如果实际没唤醒而没人知道，
 * 等于自动化静默失效 —— 这是本项工作反复踩的同一个坑。
 */

import type { RuleEvent } from './runner.js';
import type { Where } from './types.js';

/** 本模块需要的最小端口面（只声明用到的两个方法） */
export interface WakePort {
  runPrompt?(channel: string, sessionId: string, prompt: string): Promise<void>;
  runPromptInNewSession?(opts: {
    channel: string;
    prompt: string;
    deliverSessionId?: string;
    ttlMs?: number;
  }): Promise<void>;
}

export type WakeSessionFn = (where: Where, prompt: string, event: RuleEvent) => Promise<void>;

/** 未指定渠道时的兜底（与项目默认主渠道一致） */
const DEFAULT_CHANNEL = 'webui';

/**
 * 造一个 `wake` 动作的实现。
 *
 * @param getPort 惰性取端口（端口可能在装配后才注入，不能在构造时就抓死）
 */
export function createWakeSession(getPort: () => WakePort | undefined): WakeSessionFn {
  return async (where, prompt, event) => {
    const port = getPort();
    if (!port) {
      throw new Error('会话端口未注入：无法唤醒会话（检查 server.ts 是否 setSchedulerSessionPort）');
    }

    const target = where.target ?? {};
    // 渠道优先级：显式指定 > 降级链首个 > 默认
    const channel = target.channel ?? where.fallback?.[0] ?? DEFAULT_CHANNEL;

    if (where.policy === 'reuse') {
      if (!target.sessionId) {
        // 校验层已拦，这里再兜一次（链路可能来自手工编辑的配置）
        throw new Error('Where.policy=reuse 需要 target.sessionId');
      }
      if (!port.runPrompt) {
        throw new Error('会话端口未实现 runPrompt：无法复用已有会话');
      }
      await port.runPrompt(channel, target.sessionId, prompt);
      return;
    }

    // policy === 'new'
    if (!port.runPromptInNewSession) {
      throw new Error('会话端口未实现 runPromptInNewSession：无法开临时会话');
    }
    await port.runPromptInNewSession({
      channel,
      prompt,
      // new 策略下 target.sessionId 的语义是"结果投回这里"，不是"在这里跑"
      ...(target.sessionId ? { deliverSessionId: target.sessionId } : {}),
      ...(typeof where.ttlMs === 'number' && where.ttlMs > 0 ? { ttlMs: where.ttlMs } : {}),
    });
    void event; // 事件信息已体现在 prompt 里；保留参数便于将来做更细的路由
  };
}
