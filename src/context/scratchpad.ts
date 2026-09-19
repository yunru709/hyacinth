/**
 * scratchpad.ts — **临时记事本**（Zone 5，时间戳之后）
 *
 * ── 用户裁定（2026-09-19）─────────────────────────────────────────────
 *   · 注册进 **Zone 5**，位置在**时间戳之后**（= 那一轮最后的 live 区）；
 *   · agent 用 **edit 工具**自行在上面记东西 ⇒ **不占消息历史** ✗ ——
 *     它是 Zone 5 的 live 内容，每轮现读现注入，**不进消息流转** ✓
 *     （否则上下文里会堆满一份份记事本 ✗）；
 *   · 文件与 memory **同目录**：`~/.agent/prompts/persona/` ✓；
 *   · 本质是"**放在 Zone 5 里的 memory**"，但比 memory 更临时、可随手改。
 *
 * ── 为什么单独成模块（而不是写在 context-sources.ts 的闭包里）──────────
 * 闭包里的逻辑没法单测；这里抽成**纯函数**，注入点只负责调用 ✓。
 * 与 `companion_memory` 的做法一致（那里也是每轮现读一个 .md ✓）——
 * "看看 memory 那边怎么做的，模仿一下"就是这个意思 ✓。
 *
 * ── 边界（有意）──────────────────────────────────────────────────────
 *   · 文件不存在 / 为空 ⇒ 返回 ''（不注入任何东西，不占位 ✓）
 *   · 超长 ⇒ **截断**并显式标注（Zone 5 是每轮的 live 尾巴，跑飞了会把上下文撑爆 ✗）
 *   · 读失败一律静默返回 ''（诊断通道不得影响主流程 ✓ 与门控/清单同款语义 ✓）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 记事本文件位置 —— 与 memory 同目录（用户指定） */
export function scratchpadPath(): string {
  return path.join(os.homedir(), '.agent', 'prompts', 'persona', 'scratchpad.md');
}

/** 默认上限（字符）。可在本地配置里改：`context.scratchpadMaxChars` */
export const SCRATCHPAD_DEFAULT_MAX_CHARS = 8000;

/**
 * 生成注入文本。空内容 ⇒ ''（不注入）。
 *
 * @param maxChars 上限；超出则截断并标注（显式告诉模型"这里被截了"，不留错觉 ✓）
 */
export function readScratchpadForContext(maxChars: number = SCRATCHPAD_DEFAULT_MAX_CHARS): string {
  const file = scratchpadPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return ''; // 没建过这个文件 ⇒ 什么都不注入
  }
  const body = raw.trim();
  if (!body) return '';

  const capped = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : SCRATCHPAD_DEFAULT_MAX_CHARS;
  const shown = body.length > capped
    ? body.slice(0, capped) + `\n\n[已截断：全文 ${body.length} 字符，上限 ${capped}（改 context.scratchpadMaxChars 可调）]`
    : body;

  // 头一行自报位置与性质：模型据此知道"这是给我的便签"，也知道被截时该怎么办
  return [
    '# scratchpad',
    `(系统提供 · 临时记事本；文件：${file}；不进消息历史，只出现在本轮的 Zone 5 live 区)`,
    '',
    shown,
  ].join('\n');
}

/** 首次使用时预置的初始内容 —— **声明这个记事本的位置**（用户要求 ✓） */
export const SCRATCHPAD_SEED = [
  '<!-- 临时记事本（Zone 5）',
  '     位置：~/.agent/prompts/persona/scratchpad.md（与 memory.md 同目录）',
  '     用法：直接用 edit 工具在这份文件上增删 —— 它每轮现读现注入，不进消息历史。',
  '     性质：比 memory 更临时；记完即用、用完即删，别当长期记忆用（长期记忆放 memory.md）。',
  '     上限：默认 8000 字符，超出会被截断并在注入文本里标注（配置项 context.scratchpadMaxChars）。',
  '-->',
  '',
].join('\n');

/** 文件不存在时创建它并写入预置说明（幂等；已存在则原样不动 ✓） */
export function ensureScratchpadFile(): boolean {
  const file = scratchpadPath();
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SCRATCHPAD_SEED, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
