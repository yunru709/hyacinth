// ============================================================
// goal-reviewer —— goal 模式的「对抗式验收官」（审查子 agent）
// ============================================================
// 定位：finish_goal 这个工具的背后跑的就是它 —— 判定「**目标（objective）是否已经达成**」。
//
// ⚠️ 2026-10-10 修（实测缺陷，用户报告）：原判据写成「证据是否支持结论」，于是——
//    提交者交一份**诚实的负面报告**（"目标没有达成，本轮价值是…"）时，证据完美支撑该结论
//    ⇒ 判 pass ⇒ **出口被绕过**。根因：「证据支持结论」≠「目标达成」。
//    现在判据分两步：**第 0 步硬门**先看 conclusion 是否主张「目标已达成」（不是就 fail），
//    第 1 步才看证据能否支撑该主张。并新增机器可断言的 `objective_achieved` 字段 ——
//    loop.submitGoal 侧还有一道兜底（即使这里判绿，objective_achieved≠true 也按不通过处理）。
//
// 与普通子 agent 的异同（2026-10-10 用户裁定）：
//   · 一致：同一套 createSubAgentLoop；独立 userId（KVCache 隔离）；工具按白名单过滤；
//           窗口随自身通道走；不继承主 loop 的模式。
//   · 不同①：模型走 **assessment 角色通道**（用户裁定「独立」）—— 审查是独立职能，
//            可单独绑一个更严 / 更强的模型，与干活的子 agent 隔离。
//   · 不同②：工具 = read / glob / grep / bash —— 能读、也能跑命令**自行复核**；
//            核验深度由它自己判断（有的结论看一眼就清楚，不必跑）。
//   · 不同③：**每轮全新 session**（用后即弃）—— 否则会被自己上一轮的判断锚定（bias）。
//
// 返回结构化裁决 { verdict, reason, objectiveAchieved }。
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentDefinition } from '../types.js';
import type { GoalReviewRequest, GoalReviewResult } from '../orchestrator/goal.js';
import {
  createSubAgentLoop, registerRunningLoop, unregisterRunningLoop, type SubAgentContext,
} from './delegate-tool.js';

/** 审查官可用工具：能看（read/glob/grep）、能跑（bash），但不给 write/edit —— 它不该改东西 */
export const GOAL_REVIEWER_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'bash'];

const REVIEWER_SYSTEM_PROMPT = [
  '你是一名**对抗式验收官**。职责不是帮忙，而是**找茬**：判定**目标（objective）是否已经达成**。',
  '',
  '你会收到三样：目标（objective，唯一判据）、提交者的结论（conclusion）、提交者的证据（evidence）。',
  '',
  '【第 0 步 · 硬门 —— 先做这一步，不通过就直接 fail】',
  '结论是否**明确主张「目标已经达成」**？',
  '- 若结论是「未达成 / 部分达成 / 只探明了某点 / 本轮价值是… / 还需要后续工作 / 负面结果 / 给出下一步计划」',
  '  —— **一律判 fail**，reason 直接写清「目标未达成」。',
  '- 哪怕这些结论被证据完美支撑，**也照样 fail**。',
  '- 记住：「证据支持结论」**不等于**「目标达成」。一份诚实但未达成的报告，仍然必须被打回继续工作。',
  '',
  '【第 1 步 · 核验】只有在结论确实主张「目标已达成」之后，才审：证据是否足以支撑这一主张。',
  '- 空口断言、与结论无关的内容、你自己能轻易推翻的说法 → fail。',
  '- 你可以先只读证据；**是否亲自复核由你判断** —— 有的结论看一眼就清楚，不必跑；',
  '  有疑虑时，用 read / glob / grep / bash 亲自查看文件或跑命令核实（你有这些工具）。',
  '',
  '- 只审「目标达成没有」，不要提与目标无关的改进建议。',
  '- fail 时 reason 要说清**缺什么 / 哪里不成立**，让提交者能据此补齐。',
  '',
  '输出**严格 JSON**（不要任何别的文字）：',
  '{"objective_achieved":true|false,"verdict":"pass"|"fail","reason":"<中文，一句话>"}',
  '硬性约束：objective_achieved=false 时 verdict 必须为 "fail"。',
].join('\n');

/** 构造审查官定义（每次调用换一个 instanceId ⇒ 会话全新，避免跨审查锚定） */
function makeReviewerDef(instanceId: string): AgentDefinition {
  return {
    name: 'goal-reviewer',
    instanceId,
    description: 'goal 模式验收官：判定目标是否已达成，并核验证据是否支撑该主张',
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    allowedTools: [...GOAL_REVIEWER_TOOLS],
    maxTurns: 12,
    outputFormat: 'json',
  };
}

/** 从子 agent 会话的 conversation.jsonl 取最后一条 assistant 文本 */
async function readLastAssistantText(subSessionDir: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(subSessionDir, 'conversation.jsonl'), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(lines[i]!) as { role?: string; content?: unknown };
        if (msg?.role !== 'assistant') continue;
        const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
        const text = blocks
          .filter((b): b is { type: string; text?: string } => (b as { type?: string })?.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('')
          .trim();
        if (text) return text;
      } catch {
        /* skip malformed line */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从文本里抠出裁决 JSON（容忍 ```json 围栏与前后杂字）。
 *
 * `objectiveAchieved` 取**严格相等 true** 判定：字段缺失 / 类型不对 → false（保守）。
 * 这一点很关键 —— 它是「目标未达成却被放行」的机器可断言闸门（见文件头 2026-10-10 修）。
 */
export function parseVerdict(
  text: string,
): { verdict: 'pass' | 'fail'; reason: string; objectiveAchieved: boolean } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      verdict?: unknown;
      reason?: unknown;
      objective_achieved?: unknown;
    };
    if (obj?.verdict !== 'pass' && obj?.verdict !== 'fail') return null;
    return {
      verdict: obj.verdict,
      reason: typeof obj.reason === 'string' ? obj.reason : '',
      objectiveAchieved: obj.objective_achieved === true,
    };
  } catch {
    return null;
  }
}

/**
 * 创建审查官实现（装配方注入 `loop.setGoalReviewer`）。
 *
 * @param ctx 子 agent 上下文（装配方构造；`createSubProvider` 应绑 **assessment** 角色通道）
 */
export function createGoalReviewer(
  ctx: SubAgentContext,
): (req: GoalReviewRequest) => Promise<GoalReviewResult> {
  return async (req: GoalReviewRequest): Promise<GoalReviewResult> => {
    const instanceId = `goal-reviewer-${Date.now().toString(36)}-${req.attempt}`;
    const def = makeReviewerDef(instanceId);

    // 审查官不该继承主 agent 的 goal 模式 —— 它是独立 loop，天然不继承 ✓
    const task = [
      '## 目标（objective）',
      req.objective,
      '',
      '## 提交者声称的结论（conclusion）',
      req.conclusion,
      '',
      '## 提交者提供的证据（evidence）',
      req.evidence,
    ].join('\n');

    let subSessionDir: string | null = null;
    try {
      const created = await createSubAgentLoop(def, task, ctx);
      subSessionDir = created.sessionDir;
      registerRunningLoop(instanceId, created.loop);
      try {
        await created.loop.run(task);
      } finally {
        unregisterRunningLoop(instanceId);
      }
      const text = await readLastAssistantText(created.sessionDir);
      const parsed = text ? parseVerdict(text) : null;
      if (!parsed) {
        return {
          verdict: 'fail',
          reason: '审查官未返回可解析的裁决（要求严格 JSON：{"objective_achieved":bool,"verdict":"pass"|"fail","reason":"..."}）。请重新提交 finish_goal。',
        };
      }
      return {
        verdict: parsed.verdict,
        reason: parsed.reason,
        objectiveAchieved: parsed.objectiveAchieved,
      };
    } catch (err) {
      return { verdict: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      // 用后即弃：删掉本轮审查会话，避免堆积，也避免下一轮被锚定
      if (subSessionDir) {
        await fs.rm(subSessionDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}
