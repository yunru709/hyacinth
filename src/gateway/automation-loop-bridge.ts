/**
 * loop → TriggerHub 事件桥（T2，2026-10-31 复核方案 §四）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 解决什么
 * ────────────────────────────────────────────────────────────────────────────
 * automation 的 event 类规则（when.kind='event'）需要 loop 钩子作为事件源：
 * hub sink（agent-assembly）早已把 `source==='loop'` 的事件名映射为钩子名本身，
 * 但**没有任何东西往 hub fire** —— 规则写得出来、校验过得去、永远不触发。
 * 本模块补上 fire 侧：把 loop 的钩子观察者接到 hub（经注入的 fire 回调）。
 *
 * 分层：本模块住在装配层 —— 它同时认识 orchestrator 的 LoopHookBus 与
 * trigger 的 fire 动作；automation 层与 trigger 层都不该认识对方
 * （trigger 是基础层，automation 不 import trigger 类型 —— 与 hub sink 的注释同一纪律）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 关键语义（复核报告 §四，逐钩子定案）
 * ────────────────────────────────────────────────────────────────────────────
 * 1. **白名单进桥**：10 钩子 - onStreamEvent（流式高频，payload 含完整 event 对象，
 *    进桥既淹没 hub 历史也无规则语义）。
 *    beforeToolExecute 已核实（loop-tools.ts:162/634 经 HookBus.run 消费，runInner 通知
 *    observers）—— 观察者会被通知，可进桥。
 * 2. **afterToolExecute 按 result 扇出**：一批 emit（{turn, results[]}）→ 每个 result 一条
 *    事件（name=`afterToolExecute:<tool>`，detail 带 id/tool/ok）。一次 write+bash 混合批
 *    是**合法的两个不同发生**，各带各自 toolUse id —— 扇出层不得再去重掉它们。
 * 3. **eventId 去重**：进程内 LRU（Map 实现）。语义："同一逻辑发生只投递一次"，
 *    防御钩子观察者被重复挂载（装配重入）导致的同发生双投。键规则：
 *      - turn 型（onTurnStart / before·afterContextAssemble / beforeToolExecute）：
 *        `${sessionId}:${hook}:${turn}` —— 这些钩子的 turn 就是 currentTurn（实例级
 *        全局迭代号，永不重置）⇒ 天然唯一。
 *      - iteration 型（before·onIterationEnd / onTurnEnd / onTurnError）：
 *        `${sessionId}:${hook}:${iteration}` —— `iteration` 由 loop emit 点补入
 *        （loop.ts，= this.currentTurn）。**不能直接用 turn**：turnCount 每个用户回合
 *        从 1 重来，"每次对话只有一轮"是常态 ⇒ onTurnEnd:1 会跨回合碰撞，把合法的
 *        后续回合全部错误去重掉（复核方案①，字段语义按实际代码修正后落地）。
 *      - afterToolExecute：`${sessionId}:afterToolExecute:${result.id}` —— id 即
 *        provider tool_use id，全局唯一（复核实测"toolUse id 更稳"成立）。
 * 4. **sessionId 活取值**：deps.getSessionId() 每事件现取 —— loop 实例跨会话存活
 *    （applyPendingSessionSwitch 改写 sessionDir），装配期捕获必然陈旧
 *    （与 loop.currentSessionDir 注释同一坑）。
 * 5. **大对象不出桥**：history / messages / 完整 tool input / stream event 不进 detail
 *    （hub 保留 100 条历史，塞大对象是无谓的内存放大）；userInput 截 500 字符。
 */

import type { Disposable } from '../kernel/types.js';
import { toDisposable } from '../kernel/types.js';
import type { LoopHookBus, LoopHooks } from '../orchestrator/loop-hooks.js';

/** 进桥白名单（10 钩子 - onStreamEvent；次序 = LOOP_HOOK_NAMES 中的声明序） */
export const LOOP_BRIDGE_HOOK_NAMES = [
  'onTurnStart',
  'beforeContextAssemble',
  'afterContextAssemble',
  'beforeToolExecute',
  'afterToolExecute',
  'beforeIterationEnd',
  'onIterationEnd',
  'onTurnEnd',
  'onTurnError',
] as const satisfies ReadonlyArray<keyof LoopHooks>;

export type LoopBridgeHookName = (typeof LOOP_BRIDGE_HOOK_NAMES)[number];

/** 出桥的一条事件（装配层接 hub.fire({source:'loop', name, detail})） */
export interface LoopBridgeEvent {
  /** 事件名 = 钩子名；afterToolExecute 按 result 扇出为 `afterToolExecute:<tool>` */
  name: string;
  /** 载荷（已精简，大对象不出桥；规则侧经 $event.* 读取） */
  detail: Record<string, unknown>;
  /** 去重键（见模块头注释的键规则） */
  eventId: string;
}

export interface LoopBridgeDeps {
  /** loop 的钩子总线（AgentLoop.loopHooks） */
  hooks: LoopHookBus;
  /** 会话 id 活取值（装配层传 `() => path.basename(loop.currentSessionDir)`） */
  getSessionId: () => string;
  /** 出桥动作。桥不认识 trigger 类型 —— 装配层注入 `hub.fire` 适配 */
  fire: (e: LoopBridgeEvent) => void | Promise<void>;
  /** LRU 容量，默认 2048（每迭代约 6 个事件，足够覆盖一次装配生命周期内的重放防御） */
  dedupCapacity?: number;
}

/** userInput 出桥截断长度（与 defaultWakePrompt 的 slice(0,500) 同一量级） */
const USER_INPUT_SLICE = 500;

/** eventId 用 turn（= currentTurn，全局唯一）而非 iteration 的钩子 */
const TURN_KEYED_HOOKS: ReadonlySet<string> = new Set([
  'onTurnStart',
  'beforeContextAssemble',
  'afterContextAssemble',
  'beforeToolExecute',
]);

/**
 * 把白名单钩子接到出桥动作。返回 disposer（卸载全部观察者）。
 *
 * 观察者内不做 try/catch：HookBus 对 observer 异常已隔离+记录（hook-bus.ts handleError），
 * 桥内再包一层只会把问题埋进双重日志。
 */
export function bridgeLoopHooks(deps: LoopBridgeDeps): Disposable {
  const capacity = Math.max(1, deps.dedupCapacity ?? 2048);
  // Map 当 LRU：has/get 不保序，delete+set 手动刷新位次；超容淘汰最老（首键）
  const seen = new Map<string, true>();

  const once = (eventId: string, emit: () => void): void => {
    if (seen.has(eventId)) return; // 同一逻辑发生只投递一次
    seen.delete(eventId);
    seen.set(eventId, true);
    if (seen.size > capacity) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    emit();
  };

  const disposers: Disposable[] = [];
  for (const hook of LOOP_BRIDGE_HOOK_NAMES) {
    disposers.push(
      deps.hooks.on(hook, (payload) => {
        const p = payload as Record<string, unknown>;
        const sessionId = deps.getSessionId();
        const turn = typeof p.turn === 'number' ? p.turn : 0;
        // iteration 型钩子：emit 点已补全局迭代号；防御性回退 turn（缺字段时不致误判为同一发生）
        const iteration = typeof p.iteration === 'number' ? p.iteration : turn;

        if (hook === 'afterToolExecute') {
          // ── 按 result 扇出：一批 = 每个工具调用一条事件（合法的不同发生，互不去重） ──
          const results = Array.isArray(p.results) ? p.results : [];
          results.forEach((r, i) => {
            const item = (r ?? {}) as { id?: string; name?: string; ok?: boolean };
            const tool = typeof item.name === 'string' ? item.name : 'unknown';
            const id = typeof item.id === 'string' && item.id ? item.id : undefined;
            // toolUse id 全局唯一 ⇒ 最稳去重键；防御：无 id 时按 turn+位次
            const eventId = id
              ? `${sessionId}:afterToolExecute:${id}`
              : `${sessionId}:afterToolExecute:${turn}:${tool}:${i}`;
            once(eventId, () => {
              void deps.fire({
                name: `afterToolExecute:${tool}`,
                detail: { turn, ...(id ? { id } : {}), tool, ok: item.ok === true },
                eventId,
              });
            });
          });
          return;
        }

        // ── 其余钩子：一条 emit = 一条事件；eventId 是唯一去重键（单一真源） ──
        const eventId = `${sessionId}:${hook}:${TURN_KEYED_HOOKS.has(hook) ? turn : iteration}`;
        once(eventId, () => {
          void deps.fire({ name: hook, detail: buildDetail(hook, p, turn, iteration), eventId });
        });
      }),
    );
  }

  return toDisposable(() => {
    for (const d of disposers) d.dispose();
    seen.clear();
  });
}

/** 每钩子的出桥载荷（精简：大对象不出桥，见模块头注释第 5 条） */
function buildDetail(
  hook: LoopBridgeHookName,
  p: Record<string, unknown>,
  turn: number,
  iteration: number,
): Record<string, unknown> {
  switch (hook) {
    case 'onTurnStart':
      return { turn };
    case 'beforeContextAssemble':
      return {
        turn,
        userInput:
          typeof p.userInput === 'string' ? p.userInput.slice(0, USER_INPUT_SLICE) : '',
        toolNames: Array.isArray(p.toolNames) ? p.toolNames : [],
      };
    case 'afterContextAssemble':
      return { turn, tokens: typeof p.tokens === 'number' ? p.tokens : 0 };
    case 'beforeToolExecute':
      // 只出 id/name：完整 input 可能是整份写文件内容/截图 base64，桥不做内存放大
      return {
        turn,
        calls: Array.isArray(p.calls)
          ? p.calls.map((c) => {
              const item = (c ?? {}) as { id?: string; name?: string };
              return { ...(typeof item.id === 'string' ? { id: item.id } : {}), ...(typeof item.name === 'string' ? { name: item.name } : {}) };
            })
          : [],
      };
    case 'beforeIterationEnd':
    case 'onIterationEnd':
      return {
        turn,
        iteration,
        stop: p.stop === true,
        ...(typeof p.stopReason === 'string' ? { stopReason: p.stopReason } : {}),
      };
    case 'onTurnEnd':
      return {
        turn,
        iteration,
        tokensUsed: typeof p.tokensUsed === 'number' ? p.tokensUsed : 0,
        ...(typeof p.stopReason === 'string' ? { stopReason: p.stopReason } : {}),
      };
    case 'onTurnError':
      return {
        turn,
        iteration,
        error: p.error instanceof Error ? p.error.message : String(p.error ?? ''),
      };
  }
  // 穷尽性护栏：白名单新增钩子而 buildDetail 未跟进 ⇒ 运行时立刻可见（而不是静默空载荷）
  throw new Error(`[automation-loop-bridge] 未实现载荷映射的钩子: ${hook}`);
}
