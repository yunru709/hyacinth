/**
 * session-scratchpad.ts — **会话级记事本**（Zone 5，与全局 scratchpad 并列）
 *
 * ── 用户裁定（2026-10-29）─────────────────────────────────────────────
 *   · 全局 scratchpad（utils/scratchpad.ts）= **跨会话**共享：环境事实 / 工程纪律；
 *   · 本文件 = **会话专属**：待办 / 待验证 / 临时提醒，文件在 `<sessionDir>/scratchpad.md`，
 *     **随会话删除而销毁** ✓ —— 多会话并行时各自独立，不再互相串。
 *   · 注入位置同 Zone 5；由 section-resolver 特判 `runtime:session_scratchpad`，
 *     用 `ctx.sessionDir` **每轮现读**（ContextSource.getContent 不收 ctx，故走特判
 *     而非 source —— 与 timestamp/userInput 同套路）。
 *
 * ── 与全局版的唯一差异 ────────────────────────────────────────────────
 *   · **即使为空也返回带路径的头部**：这是本会话专属便签，模型必须始终知道路径
 *     （否则无从用 edit 写入）。全局版为空即不注入（它可能压根没建）。
 *   · 无 sessionDir（子 Agent 等无会话上下文）⇒ 返回 ''（不注入）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { scratchpadMaxChars } from '../context/context-config.js';
import { SCRATCHPAD_DEFAULT_MAX_CHARS, homeRelative } from './scratchpad.js';

/** 会话级记事本文件：<sessionDir>/scratchpad.md */
export function sessionScratchpadPath(sessionDir: string): string {
  return path.join(sessionDir, 'scratchpad.md');
}

/**
 * 生成会话记事本的注入文本。
 * 无 sessionDir 时返回 ''；文件不存在时仍返回带路径的头部（模型据此知道往哪写）。
 */
export function readSessionScratchpadForContext(
  sessionDir: string | undefined,
  maxChars: number = scratchpadMaxChars(),
): string {
  if (!sessionDir) return '';
  const file = sessionScratchpadPath(sessionDir);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    /* 尚未建 ⇒ 空（头部仍注入，给出路径） */
  }
  const body = raw.trim();
  const capped =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : SCRATCHPAD_DEFAULT_MAX_CHARS;
  const shown =
    body.length > capped
      ? body.slice(0, capped) + `\n\n[已截断：全文 ${body.length} 字符，上限 ${capped}]`
      : body;
  return [
    '# 会话记事本（本会话专属 · 随会话删除销毁）',
    `(系统提供；文件：${homeRelative(file)}；用 edit 写入；不进消息历史，只在 Zone 5 live 区)`,
    '',
    shown || '（空 —— 可用 edit 写本会话的待办 / 临时事项；跨会话耐久的放全局 scratchpad）',
  ].join('\n');
}

/** 会话记事本首次使用的种子（幂等；不存在才建） */
export function ensureSessionScratchpadFile(sessionDir: string): boolean {
  const file = sessionScratchpadPath(sessionDir);
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        `# 会话记事本（本会话）· ${homeRelative(file)}`,
        '',
        '<!-- 本会话专属：待办 / 待验证 / 临时提醒。随本会话删除而销毁。',
        '     跨会话耐久的（环境事实 / 工程纪律）请放全局 scratchpad。 -->',
        '',
      ].join('\n'),
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}
