/**
 * 出口配置 `<sessionDir>/exit.json` —— 声明本会话**允许哪些出口**。
 * 2026-11-02（自主模式 P2 后半）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 语义：**没被列出的出口 = 被屏蔽**
 * ────────────────────────────────────────────────────────────────────────────
 *   { "exits": ["suspend"] }                    → 只有挂起能结束回合
 *   { "exits": ["end_turn","deliver","suspend"] } → 全部放行（等于历史行为）
 *
 * 为什么用"白名单"而不是"禁用列表"：出口是**安全边界**（哪些方式能结束一个回合），
 * 白名单的失败模式是"多问一句"，黑名单的失败模式是"偷偷留了个后门"。
 *
 * ⚠️ **文件不存在 ⇒ 完全不介入**（不装任何拦截）。
 *    这条是零回归的保证：老会话没有 exit.json，行为必须与改动前逐字一致。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * inherit：让"出口配置"跨轮继承
 * ────────────────────────────────────────────────────────────────────────────
 *   suspend({ until, inherit: true }) ⇒ 下次启动沿用本文件的 exits，
 *   不必每轮重新声明"我现在是自主模式"。落点就是本文件（与 goal.json 同级）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 已知出口 id（未知值一律忽略，不报错 —— 配置坏掉不该让会话起不来） */
export const KNOWN_EXITS = ['end_turn', 'deliver', 'suspend'] as const;
export type ExitId = (typeof KNOWN_EXITS)[number];

export interface ExitConfig {
  /** 允许的出口 id 列表 */
  exits: string[];
  /** 下次进入该会话时是否沿用本配置 */
  inherit?: boolean;
}

export function exitConfigPath(sessionDir: string): string {
  return path.join(sessionDir, 'exit.json');
}

/**
 * 读回出口配置。
 * 不存在 / 结构损坏 / exits 为空数组 → **null（= 不介入）**。
 * 空数组按"没配"处理而不是"屏蔽全部"：否则一个手抖就会让会话再也停不下来。
 */
export function loadExitConfig(sessionDir: string): ExitConfig | null {
  try {
    const raw = fs.readFileSync(exitConfigPath(sessionDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ExitConfig>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.exits) || parsed.exits.length === 0) return null;
    const exits = parsed.exits.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
    if (exits.length === 0) return null;
    const cfg: ExitConfig = { exits };
    if (parsed.inherit === true) cfg.inherit = true;
    return cfg;
  } catch {
    return null; // 坏了就当没配 —— 宁可行为回到默认，也不要让会话卡死
  }
}

export function saveExitConfig(sessionDir: string, cfg: ExitConfig): boolean {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(exitConfigPath(sessionDir), JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function clearExitConfig(sessionDir: string): void {
  try {
    fs.rmSync(exitConfigPath(sessionDir), { force: true });
  } catch {
    /* 幂等 */
  }
}

/** 该出口是否被允许。无配置（null）⇒ 全部允许（零回归）。 */
export function isExitAllowed(cfg: ExitConfig | null, id: ExitId): boolean {
  if (!cfg) return true;
  return cfg.exits.includes(id);
}
