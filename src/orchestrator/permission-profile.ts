// ============================================================
// 会话级执行档位（permission profile）
// ============================================================
// 四档，从松到紧列在 PERMISSION_PROFILES 里；WebUI 的「模式菜单」直接按这个顺序渲染，
// 顺序本身就是 UI 契约（最危险的在最下面，勾选状态一眼可见）。
//
//   full          完全访问：跳过所有确认。等价于原 AOR（Absence of Restriction）。
//   auto-approve  自动确认：常规工具不问，只有「越界写入」才问。
//   confirm       变更前确认：敏感工具 + 越界写入都问（历史默认行为）。
//   plan          计划模式：只读 —— 写工具与 bash 直接拒绝，agent 只能先出计划。
//
// ────────────────────────────────────────────────────────────────────────────
// ⚠️ 命名变更（2026-11-05）：`auto` → `auto-approve`
// ────────────────────────────────────────────────────────────────────────────
// 原来是 `auto`，而"自主模式"（可自主起回合、常驻等待的那种）也叫 auto
// （见 `orchestrator/auto-budget.ts` / `auto-global.ts` / TUI `/auto`）——
// **两个完全不同功能共用一个名字**，而且本注释旧版原文就写着"auto 自主模式"，
// 谁读到这里都会以为是同一件事（2026-11-05 我本人就误判过一次）。
//
// 这一档的真实语义是「自动确认（auto-approve）常规调用」，与"自主/常驻"无关：
// 它管的是**要不要弹窗**，不是**能不能自己醒来**。故改名以消歧。
//
// 兼容：磁盘上可能仍存着旧值 `"auto"`（`<sessionDir>/allowlist.json` 的 profile、
// 或协议入参）。`normalizePermissionProfile()` 会把它映射到新值，不会失效、也不会
// 因认不出而退回更松/更紧的档位。
//
// 其余五个同名不同物的 `auto`（均为局部参数，与本档无关，已就地加注释）：
//   · `http-request` 的 `format:'auto'`（响应体自动提取正文）
//   · `cosyvoice` / `types` 的 `mirror:'auto'`（TTS 镜像自动选）
//   · `wizard` 的 `{value:'auto'}`（自动下载编译）
//   · `provider.routeMode:'automatic'`（模型路由自动选，本仓已同批改名）
//
// ## 为什么单独成档，而不是复用 safety.requireConfirmation
// 后者是**全局配置**：改一次影响所有会话。用户要的是"这个会话放得开、那个会话收得紧"，
// 会话级真源必须落在 loop 上（与 allowlistTools / restricted 同层），并随
// `<sessionDir>/allowlist.json` 持久化 —— 否则切会话 / 重启就漂移。
//
// ## 与既有机制的关系（改这里务必一起看）
// · full 是 unrestricted 的**新家**：loop.getUnrestricted() 派生自它；权限条上的
//   'aor'（全部放行）等价于切到 full 档 —— 两套状态不再各存一份、不会打架。
// · confirm 档**保留** allowlistTools / allowedCommands / "总是允许"那套老链路：
//   decideGate 对它返回 'legacy'，由 loop-tools 继续走原顺序。这样历史行为零变更。
// ============================================================

import { isMutatingTool } from '../tools/side-effect.js';

export type PermissionProfile = 'plan' | 'confirm' | 'auto-approve' | 'full';

/** 顺序即 UI 顺序：从最克制到最放开 */
export const PERMISSION_PROFILES: readonly PermissionProfile[] = ['plan', 'confirm', 'auto-approve', 'full'];

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = 'confirm';

/** 中文名（后端提示语用；WebUI 自己有一份更长的 title + description） */
export const PERMISSION_PROFILE_LABELS: Record<PermissionProfile, string> = {
  plan: '计划模式（只读）',
  confirm: '变更前确认',
  'auto-approve': '自动确认',
  full: '完全访问',
};

/** 旧值 → 新值。只登记历史上真出现过的名字；新代码不要再往这里加。 */
const LEGACY_PROFILE_ALIASES: Record<string, PermissionProfile> = {
  auto: 'auto-approve', // 2026-11-05 改名前的档位名
};

export function isPermissionProfile(v: unknown): v is PermissionProfile {
  return typeof v === 'string' && (PERMISSION_PROFILES as readonly string[]).includes(v);
}

/**
 * 解析磁盘/协议来的值：认不出就回默认（**宁可收紧**，不因脏数据放开权限）。
 * 旧档位名先过一遍别名表，避免 rename 后老会话的 allowlist.json 被当成脏数据。
 */
export function normalizePermissionProfile(v: unknown): PermissionProfile {
  if (isPermissionProfile(v)) return v;
  if (typeof v === 'string') {
    const mapped = LEGACY_PROFILE_ALIASES[v];
    if (mapped) return mapped;
  }
  return DEFAULT_PERMISSION_PROFILE;
}

/**
 * 闸门决策（供 loop-tools 的两条执行路径共用）
 *
 * - `allow`  直接放行，不弹窗
 * - `ask`    必须问用户（跳过 allowlist —— 越界写入不吃工具级白名单）
 * - `legacy` 走原有链路：allowlistTools → bash 命令白名单 → 弹窗
 * - `block`  硬拒（计划模式），连弹窗都不给
 */
export type GateDecision = 'allow' | 'ask' | 'legacy' | 'block';

export interface GateInput {
  /** 工具名 */
  toolName: string;
  /** 是否在 dangerousTools 名单里（side-effect 推导 + 配置追加） */
  dangerous: boolean;
  /** 写入目标在工作区围栏之外（path-sandbox 同源判据） */
  outsideWrite: boolean;
}

/**
 * 计划模式下被硬拦的工具：一切**非只读**的（write 改盘 + exec 跑命令/外部副作用）。
 *
 * 为什么用 isMutatingTool 而不是 isWriteTool：bash / git_tool / process 的副作用等级是
 * 'exec' 而非 'write'，只判 write 会把最危险的那几个原样放过去。计划模式的语义就是
 * "先把方案讲清楚"，此时放行 bash 等于放行一半的写权限 —— 宁可严。
 *
 * 代价：`ls`/`cat` 这类只读命令也会被拦（bash 无法静态区分）。有意如此 ——
 * 要看内容请让 agent 走 read/glob/grep，那三个在计划模式下照常可用。
 */
export function planBlocksTool(toolName: string): boolean {
  return isMutatingTool(toolName);
}

export function decideGate(profile: PermissionProfile, input: GateInput): GateDecision {
  switch (profile) {
    case 'full':
      return 'allow';
    case 'auto-approve':
      // 自动确认只守一条线：越界写入。常规改动不再打断（用户已明确授权这档语义）
      return input.outsideWrite ? 'ask' : 'allow';
    case 'plan':
      return planBlocksTool(input.toolName) ? 'block' : 'allow';
    case 'confirm':
    default:
      // 只有"可能造成副作用或越界"的调用才需要过老链路，其余照常放行
      return input.dangerous || input.outsideWrite ? 'legacy' : 'allow';
  }
}

/** 计划模式拒绝时的 tool_result 文案：要能被模型读懂并改变策略（不是一句"失败"） */
export function planBlockMessage(toolName: string): string {
  return (
    `Blocked by plan mode: "${toolName}" is a mutating tool. `
    + 'Plan mode is read-only — present the plan first and wait for the user to switch modes before editing.'
  );
}
