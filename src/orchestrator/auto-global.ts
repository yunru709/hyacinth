/**
 * 全局自主模式开关（2026-11-04）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么从「每个会话一个 exit.json」提出来
 * ────────────────────────────────────────────────────────────────────────────
 * 孑遗定调：auto 是**进程级全局状态**（未来还要在这些 session 之上再加别的东西）。
 * 挂在会话里语义就是错的 —— 开一个会话不影响另一个，而 UI 上那个按钮（顶栏）
 * 看起来明明是全局的。这属于「界面说全局、数据是会话级」的欺骗。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 落点选择：独立文件而不是 configCenter
 * ────────────────────────────────────────────────────────────────────────────
 * 走 configCenter 要动 `defaults.ts` 的 FullConfig 结构 + config schema 校验
 * + 一堆配置一致性测试，联动面大而收益小。这里内容极小（一个开关 + 两个数），
 * 独立文件更好读、更好手改、也更好在重启后恢复。
 *
 * ⚠️ 但它**必须**是进程级单例语义：模块级缓存 + 同步读写，所有 loop 共享同一份。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 优先级：会话级覆盖全局
 * ────────────────────────────────────────────────────────────────────────────
 *   `<sessionDir>/exit.json` 存在 ⇒ 用它（允许单会话单独配，保留调试能力）
 *   不存在 ⇒ 用全局 `enabled`
 * 这样既能让「点一下全局生效」，又能在需要时对单个会话做例外。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GlobalAutoConfig {
  /** 全局开关：true ⇒ 所有会话的出口白名单都是 ['suspend'] */
  enabled: boolean;
  /** 预算（可选；省略则用代码默认 DEFAULT_AUTO_BUDGET） */
  budgetPerHour?: number;
  budgetPerDay?: number;
  /** 最后更新时刻（审计 / UI 显示用） */
  updatedAt?: string;
}

let cache: GlobalAutoConfig | null = null;

export function globalAutoPath(): string {
  return path.join(os.homedir(), '.agent', 'auto.json');
}

/** 读全局配置（进程级缓存；文件不存在/损坏 ⇒ enabled:false，绝不抛） */
export function loadGlobalAuto(): GlobalAutoConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(globalAutoPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GlobalAutoConfig>;
    cache = {
      enabled: parsed.enabled === true,
      budgetPerHour:
        typeof parsed.budgetPerHour === 'number' && parsed.budgetPerHour > 0
          ? parsed.budgetPerHour
          : undefined,
      budgetPerDay:
        typeof parsed.budgetPerDay === 'number' && parsed.budgetPerDay > 0
          ? parsed.budgetPerDay
          : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    // 坏了就当关着 —— 宁可行为回到默认，也不要让进程起不来
    cache = { enabled: false };
  }
  return cache;
}

/** 写全局配置。返回是否落盘成功（失败仍更新内存缓存，留痕由调用方做）。 */
export function saveGlobalAuto(next: {
  enabled: boolean;
  budgetPerHour?: number;
  budgetPerDay?: number;
}): boolean {
  const cfg: GlobalAutoConfig = { ...next, updatedAt: new Date().toISOString() };
  cache = cfg;
  try {
    fs.mkdirSync(path.dirname(globalAutoPath()), { recursive: true });
    fs.writeFileSync(globalAutoPath(), JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 测试用：清内存缓存（真实进程里不需要调） */
export function resetGlobalAutoCache(): void {
  cache = null;
}
