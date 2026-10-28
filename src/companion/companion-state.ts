// ============================================================
// companion-state — 陪伴模式「单一权威状态」+ 状态机不变量（2026-10-28 架构确定性）
// ============================================================
// 背景：陪伴模式的"真相"原先散在 6+ 处——
//   session.meta.type / loop.activeRouter(.name/.activeCompanionName) / loop._normalSessionDir /
//   .active-sessions.json / .last-character / world-engine.json / bypassManager.active。
// 各处各读各写 + 恢复靠多条 fallback + 无任何不变量兜底 ⇒ 任一处 desync 就产生
//   "幽灵复活成陪伴""会话丢失/莫名新建""世界引擎泄漏到普通会话"。
//
// 本模块提供确定性基座：
//   1) CompanionSnapshot：把散落状态收敛成一个**只读快照**（唯一读取出口）
//   2) resolveCompanionState(loop)：**确定性解析**——以 session.meta.type 为权威 mode，
//      其余字段从对应真源派生（不猜、不回退到"可能已过期"的全局文件）
//   3) checkCompanionInvariants(snap)：**不变量断言**，返回违规项（供日志/调试，不抛）
//
// 铁律：**只读、零副作用**。所有"陪伴状态读取"都应走 resolveCompanionState，
//       不再在 onActivate/onDeactivate/RPC/工具里各抄一份。（后续步骤：把控制流也收进来）
//
// 为什么放在 companion/（模式专属目录）：含模式名判断的分支属于"陪伴实现自身"，
// 按 verify:layers 规则7 的架构约定，泛化层（context/ 等）不得出现 -- 故归此目录。
// ============================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';

export type CompanionMode = 'normal' | 'companion';

export interface CompanionSnapshot {
  /** 权威模式：由 session.meta.type 决定（缺省 normal）——这是唯一真源 */
  mode: CompanionMode;
  /** 当前 session 的 meta.type 原值（排查用） */
  sessionType: string;
  /** 当前 session 目录 */
  sessionDir: string;
  /** session 目录名（陪伴下 = 角色名） */
  sessionBase: string;
  /** 内存中的 activeRouter.name（可能仍在切换中途，仅供参考） */
  routerName: string;
  /** 内存中的 activeCompanionName（切换参数侧信道写入，仅供参考） */
  inmemoryCharacter: string;
  /** 解析出的"应为"角色名：companion 模式非空、normal 模式恒空 */
  character: string;
  /** 世界引擎是否在跑（bypass 'world-engine' active） */
  worldRunning: boolean;
  /** 切换前保存的 normal session 目录（内存 _normalSessionDir） */
  normalSessionDir: string;
}

/** 读某 session 目录的 meta.type（缺省 normal，读失败也 normal——normal 是"安全默认"） */
function readMetaType(sessionDir: string): string {
  try {
    const m = JSON.parse(readFileSync(path.join(sessionDir, 'meta.json'), 'utf-8')) as { type?: unknown };
    return typeof m?.type === 'string' ? m.type : 'normal';
  } catch {
    return 'normal';
  }
}

/**
 * 确定性解析陪伴状态。以 **session.meta.type** 为唯一权威 mode（与跨模式闸门一致），
 * 其余字段从明确真源派生；**不**从 `.last-character`/全局文件"猜"当前角色（那是历史恢复路径的坑）。
 */
export function resolveCompanionState(loop: any): CompanionSnapshot {
  // ⚠️ switchSession 是「登记 pendingSessionDir、轮次边界才落地」⇒ onActivate/onDeactivate 期间
  // loop.sessionDir 仍是旧目录。必须**以 pendingSessionDir 为有效 session**，否则状态会在转移中途错判
  // （2026-10-28 独立调试实测：I3 因读到旧 sessionDir 而假阳性）。
  const sessionDir = String((loop as any)?.pendingSessionDir || loop?.sessionDir || '');
  const sessionBase = sessionDir ? path.basename(sessionDir) : '';
  const sessionType = readMetaType(sessionDir);
  const mode: CompanionMode = sessionType === 'companion' ? 'companion' : 'normal';

  const routerName = String(loop?.activeRouter?.name || '');
  const inmemoryCharacter = String(loop?.activeRouter?.activeCompanionName || '');

  // 角色名：companion 模式下，优先内存 activeCompanionName（显式激活刚写），否则取 session
  // 目录名（陪伴会话位于 ~/.agent/companion/<角色>/，目录名即角色名）。normal 模式一律空。
  let character = '';
  if (mode === 'companion') {
    const fromBase = sessionBase && sessionBase !== 'normal' && sessionBase !== 'sessions' ? sessionBase : '';
    character = inmemoryCharacter || fromBase;
  }

  const worldRunning = Boolean(loop?.bypassManager?.isActive?.('world-engine'));
  const normalSessionDir = String((loop as any)?._normalSessionDir || '');

  return { mode, sessionType, sessionDir, sessionBase, routerName, inmemoryCharacter, character, worldRunning, normalSessionDir };
}

export interface InvariantViolation {
  code: string;
  detail: string;
}

/**
 * 状态机不变量（返回违规项，不抛）。这些是"陪伴模式确定性"的硬约束——
 * 任何一条被违反 = 已进入不一致态，应记日志告警（并可在测试里断言为空）。
 *
 * ⚠️ 仅在**状态稳定的时刻**调用（如 onActivate 完成之后）。切换中途 activeRouter/session
 * 尚在翻转，会出现瞬时的"router≠session"——那是正常的，别在转移中途断言。
 */
export function checkCompanionInvariants(s: CompanionSnapshot): InvariantViolation[] {
  const v: InvariantViolation[] = [];
  // I1：世界引擎只允许在 companion 模式运行（这是 2026-10-28 泄漏的直接判据）
  if (s.worldRunning && s.mode !== 'companion') {
    v.push({ code: 'I1_WORLD_WITHOUT_COMPANION', detail: `worldRunning=true 但 mode=${s.mode}（session=${s.sessionBase}）` });
  }
  // I2：companion 模式必须能解析出角色名
  if (s.mode === 'companion' && !s.character) {
    v.push({ code: 'I2_COMPANION_NO_CHARACTER', detail: `mode=companion 但角色名为空（session=${s.sessionBase}）` });
  }
  // I3：稳定态下 activeRouter.name 必须与 session type 一致
  if (s.routerName && s.routerName !== s.mode) {
    v.push({ code: 'I3_ROUTER_SESSION_MISMATCH', detail: `activeRouter=${s.routerName} 但 session.mode=${s.mode}` });
  }
  return v;
}

/** 违规项 → 单行文本（日志用） */
export function formatInvariantViolations(v: InvariantViolation[]): string {
  return v.map((x) => `[${x.code}] ${x.detail}`).join('; ');
}

export interface ExitNormalSession {
  /** 退出应切回的 normal session 目录（source='none' 时为空） */
  dir: string;
  /** 来源：内存 _normalSessionDir / 持久化 .active-sessions / 无记录 */
  source: 'memory' | 'persisted' | 'none';
}

/**
 * 退出陪伴时"回到哪个 normal session"的**确定性三级解析**（顺序固定：内存 → 持久化 → 无）。
 * 只读、不建会话；'none' 交由调用方决定（应显式告警后新建，绝不静默）。
 * 持久化文件位置由 snap.sessionDir（= ~/.agent/companion/<角色>）的父目录推出，无需另传 os。
 */
export function pickExitNormalSession(snap: CompanionSnapshot, channelKey: string): ExitNormalSession {
  if (snap.normalSessionDir) return { dir: snap.normalSessionDir, source: 'memory' };
  try {
    const file = path.join(path.dirname(snap.sessionDir), '.active-sessions.json');
    const map = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const d = map && typeof map[channelKey] === 'string' ? (map[channelKey] as string) : '';
    if (d) return { dir: d, source: 'persisted' };
  } catch { /* 无持久化映射 → 落到 none */ }
  return { dir: '', source: 'none' };
}
