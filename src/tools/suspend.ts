// ============================================================
// suspend — 挂起工具：本回合不是"结束"，而是"去睡，条件到了叫我"
// ============================================================
// 2026-11-02（自主模式 P2）。
//
// 【与 deliver / say 的根本区别】
//   say      = 嘴（不判停，说完继续干活）
//   deliver  = 收工（这一轮的事做完，等人来）
//   suspend  = 挂起（这一轮先停，但**已经登记了下一次醒来的条件**）
//
//   代码上 deliver 与 suspend 都置"回合结束"标志，区别只在 stopReason：
//       'end_turn'  vs  'suspended'
//   ⚠️ suspended 必须是**独立原因**（loop.ts 的 stop 事件是单一写者，最终 reason 由它写出）：
//      上层要靠它区分「收工了」和「挂条件睡了」，并据此 arm 触发项。
//      混进 end_turn ⇒ 没人知道该去 arm 什么，自主模式直接失效。
//
// 【为什么必须有 until.kind = 'user'】
//   这是"合法静默"：没有值得等的条件时，诚实的做法就是"只在你说话时醒"。
//   没有它，自主模式会退化成"每轮结束都必须硬造一个条件" —— 为了自主而自主，
//   半夜自己叫自己起床，什么也没干，还烧钱。
//
// 【本工具不做任何 IO】
//   与 deliver/say 同构：提交函数由 loop 注入，落盘（<sessionDir>/suspend.json）
//   与 arm 触发项都在 loop 侧做。工具只负责**把模型的意思表达清楚**并校验。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

/**
 * 「等什么」。
 *
 * `kind` 与入口注册表（TriggerProvider.kind）同源 —— 出口声明的条件就是下一轮的入口，
 * 两者是同一张表的两面。已有：file / ui_region / http / process / port；另有特殊的：
 *   'user' —— 只在用户说话时醒（合法静默）
 *   'time' —— 定时（spec.afterMs / spec.at）
 */
export interface SuspendUntilSpec {
  kind: string;
  /** 该 kind 的具体参数（例如 file: {path, watch:'content'}；ui_region: {windowTitle}） */
  spec?: Record<string, unknown>;
  /** 人话描述，UI 直接展示（"VSCode 窗口画面变化"） */
  note?: string;
  /**
   * 兜底：最迟多少毫秒后无条件醒一次。
   * 用途：条件可能永远不满足（等的文件一直没变）时，不至于永久沉睡 —— 至少定期回来看看。
   */
  afterMs?: number;
}

export interface SuspendPayload {
  until: SuspendUntilSpec;
  /** 为什么挂起（写进 suspend.json，下次醒来时作为上下文的一部分） */
  note?: string;
  /**
   * 下次进入同一模式时，是否沿用本次的出口配置（exits）。
   * 与 until 无关 —— 它管的是"出口策略"，不是"唤醒条件"。
   */
  inherit?: boolean;
}

export type SuspendSubmitResult = { ok: true } | { ok: false; error: string };

/** 提交函数（loop.submitSuspend 注入） */
export type SuspendSubmitFn = (payload: SuspendPayload) => Promise<SuspendSubmitResult> | SuspendSubmitResult;

/** until.kind = 'user' 时不接受 spec（它没有任何可调参数，给了就是模型在瞎填） */
const USER_KIND = 'user';

/**
 * 从工具入参解析 until：逐字段容错，坏值给**明确错误**（不要静默接受一个空条件，
 * 那会让 agent 以为挂上了、实际醒来条件是"立即"⇒ 变成自旋）。
 */
export function parseSuspendUntil(raw: unknown): { ok: true; until: SuspendUntilSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'until 必须是一个对象，例如 {"kind":"file","spec":{"path":"src/x.ts"}}' };
  }
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind.trim() : '';
  if (!kind) {
    return {
      ok: false,
      error: 'until.kind 不能为空。可选：user（只等用户说话）/ file / ui_region / http / process / port / time',
    };
  }
  if (kind === USER_KIND && o.spec !== undefined) {
    return { ok: false, error: 'until.kind="user" 不接受 spec —— 它只表示"只在用户说话时醒"' };
  }
  const until: SuspendUntilSpec = { kind };
  if (o.spec && typeof o.spec === 'object' && !Array.isArray(o.spec)) {
    until.spec = o.spec as Record<string, unknown>;
  }
  if (typeof o.note === 'string' && o.note.trim()) until.note = o.note.trim();
  if (typeof o.afterMs === 'number' && Number.isFinite(o.afterMs) && o.afterMs > 0) {
    until.afterMs = Math.round(o.afterMs);
  }
  // ⚠️ 2026-11-05 修 bug（实测事故，别删）：
  //    `kind:'time'` 的 afterMs 常被写在 `spec` 里 —— **本工具的 description 原文就是这么教的**
  //    （`{"kind":"time","spec":{"afterMs":600000}}`）。但 `loop.armSuspendTimer` 只读
  //    **顶层** `until.afterMs` ⇒ 取不到就掉进 `armSuspendWatch` 条件分支；而 WatchService
  //    并不支持 'time'，`start()` 抛错被 catch 吞掉（只留一条 warn）⇒ 表现为
  //    **「已挂起（等待：60 秒后自动唤醒）」然后永远不会醒**。
  //    这里把 spec.afterMs 提升到顶层：两种写法都认，避免描述与实现继续打架。
  if (until.afterMs === undefined) {
    const specAfter = until.spec?.afterMs;
    if (typeof specAfter === 'number' && Number.isFinite(specAfter) && specAfter > 0) {
      until.afterMs = Math.round(specAfter);
    }
  }
  return { ok: true, until };
}

export function createSuspendTool(submit: SuspendSubmitFn): Tool {
  return {
    name: 'suspend',
    description:
      '挂起本回合：不是收工，而是**登记一个唤醒条件后去睡**，条件满足时你会在新回合里被叫醒。' +
      '本回合以此结束，stopReason = suspended。' +
      '用法：until 说明"等什么" —— ' +
      '{"kind":"user"} 只等用户说话（**没有值得等的条件时就用这个**，别硬造条件）；' +
      '{"kind":"file","spec":{"path":"src/x.ts","watch":"content"}} 等文件变化；' +
      '{"kind":"ui_region","spec":{"windowTitle":"VSCode"}} 等窗口画面变化；' +
      '{"kind":"process","spec":{"name":"node","expect":"exit"}} 等进程结束；' +
      '{"kind":"time","afterMs":600000} 定时醒（afterMs 必须放 until **顶层**；' +
      '写在 spec 里也兼容，但推荐顶层写法）。' +
      'afterMs 是兜底（最迟多久无条件醒一次），条件可能永不满足时建议带上。' +
      'note 写"为什么挂起"，下次醒来会作为上下文的一部分。' +
      '⚠️ 只在**确实要等外部变化**时用；活干完了要交结果，用 deliver。',
    inputSchema: {
      type: 'object',
      properties: {
        until: {
          type: 'object',
          description: '唤醒条件。kind 必填：user / file / ui_region / http / process / port / time',
          properties: {
            kind: { type: 'string', description: '条件类型' },
            spec: { type: 'object', description: '该类型的参数（user 不需要）', additionalProperties: true },
            note: { type: 'string', description: '人话描述，UI 直接展示' },
            afterMs: { type: 'number', description: '兜底：最迟多少毫秒后无条件醒一次' },
          },
          required: ['kind'],
        },
        note: { type: 'string', description: '为什么挂起（下次醒来时的上下文）' },
        inherit: { type: 'boolean', description: '下次进入该模式时沿用本次的出口配置' },
      },
      required: ['until'],
    },
    // 只读语义：不产生外部副作用（suspend.json 由 loop 侧统一落盘），自动放行
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const parsed = parseSuspendUntil(args.until);
      if (!parsed.ok) throw new Error(parsed.error);

      const payload: SuspendPayload = { until: parsed.until };
      if (typeof args.note === 'string' && args.note.trim()) payload.note = args.note.trim();
      if (args.inherit === true) payload.inherit = true;

      const result = await submit(payload);
      if (!result.ok) {
        // 抛错 → is_error tool_result → loop 自动续轮让模型修正
        throw new Error(result.error);
      }
      const desc = parsed.until.note ?? parsed.until.kind;
      return `已挂起（等待：${desc}）`;
    },
  };
}

// ── 落盘（<sessionDir>/suspend.json；与 goal.json 同级）─────────────────────
//
// 为什么不放在工具里做：sessionDir 是 loop 的私有知识，工具层不该认识它
// （与 say/deliver 的 pendingOutputs 同一取舍）。工具只表达意图，落盘由 loop 调用这里。

export const SUSPEND_STATE_FILE = 'suspend.json';

/**
 * 落盘挂起登记。返回是否成功。
 *
 * 调用方（loop）**不该**因落盘失败而中断回合收尾 —— 那时回合已经该结束了，
 * 为了写文件把它拽回来是本末倒置。但必须留痕：否则就是"以为挂上了，重启后什么都没有"。
 */
export function saveSuspendState(
  sessionDir: string,
  payload: SuspendPayload,
  now: Date = new Date(),
): boolean {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, SUSPEND_STATE_FILE),
      JSON.stringify({ ...payload, armedAt: now.toISOString() }, null, 2),
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

/** 读回挂起登记；文件不存在 / 结构损坏 → null（与 loadGoalState 同语义：坏了就当没有） */
export function loadSuspendState(
  sessionDir: string,
): (SuspendPayload & { armedAt?: string }) | null {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, SUSPEND_STATE_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as SuspendPayload & { armedAt?: string };
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.until || typeof parsed.until.kind !== 'string' || !parsed.until.kind) return null;
    // ⚠️ 2026-11-05 兼容旧盘面：历史版本可能把 afterMs 落在 spec 里（工具描述曾这么教）。
    //    `restoreAutoMode()` 只读顶层 `until.afterMs`，读不到就会把 time 条件当成
    //    "按事件等"丢给 WatchService，而它不支持 time ⇒ 重启后永不唤醒。
    //    在**读取侧**统一提升，保证旧 suspend.json 也能被正确恢复。
    if (parsed.until.afterMs === undefined) {
      const specAfter = parsed.until.spec?.afterMs;
      if (typeof specAfter === 'number' && Number.isFinite(specAfter) && specAfter > 0) {
        parsed.until.afterMs = Math.round(specAfter);
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 清除挂起登记（醒来后调用；幂等 —— 文件可能本来就不存在） */
export function clearSuspendState(sessionDir: string): void {
  try {
    fs.rmSync(path.join(sessionDir, SUSPEND_STATE_FILE), { force: true });
  } catch {
    /* 幂等 */
  }
}
