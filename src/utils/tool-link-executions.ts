/**
 * tool-links 执行记录（2026-10-30，收敛点③：可观测）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这个模块（踩过的坑）
 * ────────────────────────────────────────────────────────────────────────────
 * `invoke` 类处理器调用工具时，返回值被 `return ''` 丢弃、失败只 console.error。
 * 结果：工具到底跑没跑、成没成功、错在哪 —— **全都看不见**。
 *
 * 2026-10-30 凌晨排查「微信关闭后 say 不出声」花了近一小时，先后排除了：
 * probe 判定、事件派发、配置 BOM、runtime 装配……最后才定位到 say 的入队语义。
 * 如果当时有一条执行记录，第一分钟就能看出来「invoke 成功了，但目标是 say」。
 *
 * 所以这里的定位是：**任何 Sink 执行的成败都要留痕**，供：
 *   1. 人类排查（看最近 N 条）
 *   2. 模型自我修正（模型设计链路时需要知道自己设计的链路跑得怎样）
 *   3. 未来 UI「自动化」页展示
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 存储策略（有意为之）
 * ────────────────────────────────────────────────────────────────────────────
 * · 内存环形缓冲（默认 200 条）：查询快、无 IO 压力 —— 高频的 append 类也不怕
 * · 失败额外落文件：因为失败最需要事后回溯，且失败通常是低频的
 *   （文件路径 ~/.agent/logs/tool-links-failures.jsonl，追加写，写失败静默）
 * · 不做全量落盘：afterToolExecute 一次回合可能触发几十次，全量写盘纯属浪费
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 一次 Sink 执行的记录 */
export interface ToolLinkExecution {
  /** 执行开始时刻（ms） */
  at: number;
  /** 触发事件名，如 `afterWatch:process` */
  event: string;
  /** 处理器 id，如 `core.invoke-tool` */
  handlerId: string;
  /** 处理器类别 */
  kind: 'append' | 'enrich' | 'invoke';
  /** invoke 类：目标工具名（其他类别为空） */
  tool?: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** 环形缓冲容量 */
const MAX_ENTRIES = 200;

const entries: ToolLinkExecution[] = [];
let totalOk = 0;
let totalFail = 0;

function failureLogPath(): string {
  return path.join(os.homedir(), '.agent', 'logs', 'tool-links-failures.jsonl');
}

/** 是否把失败写进文件。测试里关掉，免得把伪造的失败混进真实日志。 */
let fileLoggingEnabled = true;

export function setToolLinkFailureLogging(enabled: boolean): void {
  fileLoggingEnabled = enabled;
}

/** 失败落文件：尽力而为，任何异常都不冒泡（记录日志本身绝不能干扰业务） */
function appendFailureToFile(e: ToolLinkExecution): void {
  if (!fileLoggingEnabled) return;
  try {
    const p = failureLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(e) + '\n', 'utf8');
  } catch {
    /* 记不下来就算了，内存里还有 */
  }
}

/** 记录一次执行 */
export function recordToolLinkExecution(e: ToolLinkExecution): void {
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (e.ok) {
    totalOk++;
  } else {
    totalFail++;
    // 失败必须"响"：控制台 + 文件双通道。
    // 只写内存等于没写 —— 之前 console.error 就没人看见。
    console.error(
      `[tool-links] ${e.handlerId} 执行失败 on "${e.event}"`
        + (e.tool ? `（目标工具: ${e.tool}）` : '')
        + `: ${e.error ?? '(无错误信息)'}`,
    );
    appendFailureToFile(e);
  }
}

/** 最近的执行记录（按时间正序） */
export function getToolLinkExecutions(limit = 50): ToolLinkExecution[] {
  if (limit <= 0) return [];
  return entries.slice(-limit);
}

/** 汇总统计 —— 供 UI / 诊断 / 模型自查 */
export function getToolLinkExecutionStats(): {
  total: number;
  ok: number;
  fail: number;
  lastAt: number | null;
  lastError: string | null;
} {
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const lastFail = [...entries].reverse().find((e) => !e.ok);
  return {
    total: totalOk + totalFail,
    ok: totalOk,
    fail: totalFail,
    lastAt: last?.at ?? null,
    lastError: lastFail?.error ?? null,
  };
}

/** 清空（测试用） */
export function resetToolLinkExecutions(): void {
  entries.length = 0;
  totalOk = 0;
  totalFail = 0;
}
