/**
 * ExitPolicy —— 出口策略协议（2026-11-02，P1 纯重构）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么要有这层
 * ────────────────────────────────────────────────────────────────────────────
 * goal 模式本质上是**一次出口改造**（见 goal.ts 文件头）：它废掉默认的 end_turn，
 * 只留 finish_goal 一个出口，并附带工具管制。这套东西是好的，但它**绑死在 goal 上**：
 *
 *   · 工具黑名单：loop.ts 里两处硬编码调用 isToolForbiddenInGoal（装配侧 + 执行侧）
 *   · 出口闸门：applyGoalGate 里直接调 decideGoalGate
 *
 * 结果是：想再加一种出口（比如自主模式的 suspend），就得再往 loop 里塞一套同样的
 * if/else；想"屏蔽"某种出口，只能改代码。这不是扩展性，是复制粘贴。
 *
 * ⇒ 把三件套抽成 **ExitPolicy**：一个策略 = 一个出口 + 它的工具管制 + 它的闸门。
 *   启用哪些出口由会话配置声明，**没被声明的策略根本不在链里** = "屏蔽"不需要删代码。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 两条必须守住的约定
 * ────────────────────────────────────────────────────────────────────────────
 * 1. **Policy 是纯逻辑，不做副作用。**
 *    注入消息、累加 nudges、落盘、解除模式 —— 这些全部留在 loop 里做。
 *    理由：纯逻辑才能被单测直接断言；而且副作用需要会话上下文，policy 不该认识它。
 *    （goal.ts 的 decideGoalGate 已经是这个形态，本层只是把它的返回值标准化。）
 *
 * 2. **链式，且"任意一环说要继续"就继续。**
 *    多个策略同时启用时按声明顺序过闸；一旦某个策略返回 stop=false，后面的不再问
 *    —— 因为这一轮已经确定要继续跑了，再问别的只会产生互相矛盾的注入消息。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 工具裁决三态（对应 goal 现有的"黑名单 + 强制可见"）
 * ────────────────────────────────────────────────────────────────────────────
 *   'forbid' —— 从工具表里去掉，且执行侧拒绝（黑名单）
 *   'force'  —— 即便别的策略 forbid 了也要补回来（goal 的 finish_goal / exit_goal）
 *   'allow'  —— 不管
 * 装配侧（context 阶段给模型看的工具表）与执行侧（isToolAllowedForExecution）
 * **必须走同一套谓词** —— 两处不同序就会重演「看得见、调不通」（2026-10-10 踩过）。
 */

/** 出口策略给出的本轮判定 */
export interface ExitDecision {
  /** false = 不许停，本轮继续 */
  stop: boolean;
  /** 终止原因（'end_turn' / 'goal_pending' / 'suspended' / …）；undefined = 沿用传入值 */
  stopReason?: string;
  /**
   * 非空 = 要注入回对话的一段话（"你为什么不能停"）。
   * 允许 null：goal.decideGoalGate 的历史返回形态是 `message: string | null`，
   * 这里直接兼容，省掉一层无意义的转换（null 与 undefined 同义）。
   */
  message?: string | null;
  /** 是否以 warn 级别提示到 UI */
  warn?: boolean;
}

/** 工具裁决三态：见文件头 */
export type ToolVerdict = 'allow' | 'forbid' | 'force';

/**
 * 一种出口策略。
 *
 * `id` 同时是**配置里的开关名**（`exits: ['goal', 'suspend']`），所以必须稳定、
 * 不能随实现改名 —— 改名等于让老会话的 exit.json 失效。
 */
export interface ExitPolicy {
  readonly id: string;
  /**
   * 出口闸门：这一轮到底许不许结束。
   * 调用点 = loop.resolveStopGates（真正要停的时刻，每轮最多一次）。
   */
  gate(stop: boolean, stopReason: string | undefined): ExitDecision;
  /**
   * 工具裁决（可选）。不实现 = 本策略不管工具。
   * 注意：会被逐工具调用（几十次），实现要便宜（纯查表，别做 IO）。
   */
  toolVerdict?(toolName: string): ToolVerdict;
}

/** 一个策略给出的决定，供 loop 做副作用（注入消息 / 累加计数 / 落盘） */
export interface ExitPolicyDecision {
  id: string;
  decision: ExitDecision;
}

export interface ExitGateResult {
  stop: boolean;
  stopReason?: string;
  /**
   * 按执行顺序记录每一环的决定。
   * loop 用它做副作用（P1 只有 goal 会产出 message；P2 之后通用化）。
   * 注意：被 `stop=false` 截断时，**只有跑到的那几环**会出现在这里。
   */
  decisions: ExitPolicyDecision[];
}

/**
 * 跑完整条出口闸门链。
 *
 * 语义（与重构前的 applyGoalGate 严格等价）：
 *   · 没启用任何策略 → 原样放行（这就是"屏蔽"的落地形态）
 *   · 某一环返回 stop=false → 立即停止遍历，整体判"继续"
 *   · 全部放行 → 沿用最后一环给出的 stopReason（没给就沿用传入的）
 */
export function applyExitPolicies(
  policies: readonly ExitPolicy[],
  stop: boolean,
  stopReason: string | undefined,
): ExitGateResult {
  const decisions: ExitPolicyDecision[] = [];
  if (policies.length === 0) return { stop, stopReason, decisions };

  let curStop = stop;
  let curReason = stopReason;

  for (const policy of policies) {
    const decision = policy.gate(curStop, curReason);
    decisions.push({ id: policy.id, decision });
    if (decision.stopReason !== undefined) curReason = decision.stopReason;
    if (!decision.stop) {
      // 被拽回来继续：后面的策略不必再问（问了也只会产生互相矛盾的注入消息）
      return { stop: false, stopReason: curReason, decisions };
    }
    curStop = decision.stop;
  }

  return { stop: curStop, stopReason: curReason, decisions };
}

/**
 * 汇总一条工具在多策略下的最终裁决。
 *
 * 优先级：**forbid 压过 force** —— 否则"黑名单"可以被另一个策略的 force 绕开，
 * 那黑名单就形同虚设。goal 的 finish_goal 之所以能强制可见，是因为它在 goal 策略
 * 内部先判 force，而别的策略不会 forbid 它。
 */
export function resolveToolVerdict(
  policies: readonly ExitPolicy[],
  toolName: string,
): ToolVerdict {
  let forced = false;
  for (const policy of policies) {
    const verdict = policy.toolVerdict?.(toolName);
    if (verdict === 'forbid') return 'forbid';
    if (verdict === 'force') forced = true;
  }
  return forced ? 'force' : 'allow';
}

// ── 出口屏蔽策略（2026-11-02 · 自主模式 P2 后半）──────────────────────────

export const END_TURN_BLOCKED_REASON = 'exit_blocked';

/**
 * 视为「显式出口」的 stopReason —— 这些是模型/系统**主动声明**结束的方式，
 * 不属于"不知不觉就结束了"，一律放行。
 *
 * ⚠️ 为什么是白名单而不是「拦 end_turn」：见 createEndTurnBlockPolicy 的注释。
 */
const EXPLICIT_EXIT_REASONS: ReadonlySet<string> = new Set([
  'suspended',             // suspend 工具：挂起等条件（自主模式的正常出口）
  // ⚠️⚠️ 2026-11-06 定调（孑遗）：「交付」和「结束」要按模式区分。
  //    · 普通模式：deliver 就是收工 ⇒ 但那时本策略**压根不存在**（policies 为空），
  //      移除 'say_submitted' 完全影响不到普通模式 ✓
  //    · 自主模式：deliver **不结束回合** —— 内容照常送出，但回合继续，
  //      要停必须显式 suspend。交付 ≠ 结束，两件事正交。
  //    安全性：takeSayStatus() 每轮都把 sayStatus 清成 null ⇒ 判停只发生一次，
  //    不会出现"deliver 一直被拦、一直续轮"的死循环。
  //    （曾短暂实现成"suspend 时默认挂 {kind:'user'}" —— 那是错的：它仍然是回合结束，
  //      只是换了个理由。用户要的是回合本身不结束。）
  // 'say_submitted' —— 已移出，见上。
  'say_failed',            // say 中止（错误态，不该被当成"自主循环的出口"来要求 suspend）
  'goal_achieved',         // goal 验收通过
  'goal_budget_exceeded',  // goal 预算触顶放行（模式已解除）
]);

/**
 * 「只允许 suspend」时用的策略：拦下"自然结束"这个出口。
 *
 * 拦截方式刻意与 goal 一致 —— **改判继续 + 注入一句话**，而不是静默吞掉：
 * 模型必须知道"为什么停不下来"，否则它只会换个姿势再试一次。
 *
 * ⚠️⚠️ 2026-11-05 修 bug（实测事故，务必别改回去）：
 *    原实现是 `if (stopReason !== 'end_turn') return { stop }` —— **精确匹配字面量**。
 *    但 `llm.ts` 把 provider 的原始 `finish_reason` 直接透传成 `stopReason`：
 *      · OpenAI 兼容协议 → 'stop'
 *      · Anthropic      → 'end_turn'
 *      · 部分流式实现   → undefined
 *    于是**在 OpenAI 系上永远不命中**，自主模式开了也拦不住 —— 现象是
 *    "纯文本一说完回合就结束了"，而 UI 上开关明明显示开着。
 *    实测取证：`stopReason: "stop"`, `policies: ["end_turn-blocked"]`（策略装了但没生效）。
 *    ⇒ 改为白名单：只有 EXPLICIT_EXIT_REASONS 里的才放行，其余全部当作自然结束拦下。
 *    这也和 exit-config.ts 的「白名单」哲学一致（失败模式 = 多问一句，不是偷偷留后门）。
 *
 * ⚠️ 兜底：本策略不做计数。如果模型死活不调 suspend，会一直注入同一条消息直到
 *    maxTurns 熔断（它是硬围栏，不在本链里）。这是有意的取舍：
 *    宁可撞 maxTurns 被记一次账，也不要让屏蔽策略自己"悄悄放行"。
 */
export function createEndTurnBlockPolicy(hint?: string): ExitPolicy {
  return {
    id: 'end_turn-blocked',
    gate(stop: boolean, stopReason: string | undefined): ExitDecision {
      if (!stop) return { stop };
      // 显式出口放行（含 deliver → say_submitted，故拦截提示里"或用 deliver 交付结论"成立）
      if (typeof stopReason === 'string' && EXPLICIT_EXIT_REASONS.has(stopReason)) {
        return { stop, stopReason };
      }
      return {
        stop: false,
        stopReason: END_TURN_BLOCKED_REASON,
        message:
          hint ??
          '本会话只允许 suspend 作为出口：不能靠"不再调用工具"来结束回合。' +
            '请用 suspend 登记唤醒条件（无值得等的条件就用 {"kind":"user"}），' +
            '或用 deliver 交付结论。',
        warn: true,
      };
    },
  };
}
