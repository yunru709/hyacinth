// ============================================================
// ContextProfile — 模式路由层【机制 2/7: Router】
// ============================================================
//
// 职责：Router — 管模式切换。不同模式下显示/跳过哪些 section，
//        哪些工具可用，走哪个 persona。
//
// ── 模式真源：session type ──────────────────────────────────
// 模式唯一真源是**会话 meta.json 的 type 字段**（types.ts SessionType，
// 开放联合：内置 normal/companion，插件可扩展如 coding）。
// 恢复链路：meta.type → boot() 的 sessionType → loop.setSessionType()
// → loop.syncRouter() 按名解析 Router。切模式 = 切/建对应类型的 session
// （Router.onActivate 负责切换，陪伴模式即此做法）。
//
// 7 种上下文变更机制：
//   1. manifest       — 管结构（有什么 section，放哪个 zone）
//   2. Router         — 管模式（本文件）← 当前机制
//   3. Injection      — 管动态注入（旁路 Agent 运行时插入内容）
//   4. Compressor     — 管预算保护（超 token 时如何裁剪历史）
//   5. ContextSource  — 管数据供应（运行时数据从哪来）
//   6. activeConditions — 管条件开关（如 zone4_enabled）
//   7. filterHistory  — 管消息过滤（历史中哪些消息不显示）
//
// 新增模式只需：
//   1. 实现 IContextRouter 接口
//   2. 调用 registerRouter(router) 注册（Router 名 = session type 名）
//   3. 建对应类型的 session（或 loop.syncRouter(name) 显式切换）
//
// ⚠ 已知约束（别抬高预期）：
//   · **不是多 Agent**：同一个 loop 只是换上下文组装策略，换不来并行独立人格；
//     真要隔离得靠渠道 / 会话。
//   · 新增一种模式目前仍要改代码（Router 类 + 注册）；声明式 profile 化
//     （.agent/modes/*.json + 具名钩子）是既定方向，见 mode-manager 改造。
// ============================================================

import type { IContextRouter } from './router.js';
import { NormalRouter, CompanionRouter } from './router.js';

// ── Router Registry ─────────────────────────────────────────

const routerRegistry = new Map<string, IContextRouter>();

/** 注册一个 Router（通常在启动时调用；Router 名 = session type 名） */
export function registerRouter(router: IContextRouter): void {
  routerRegistry.set(router.name, router);
}

/** 按名取 Router（名 = session type）；未注册返回 undefined（调用方自行回退） */
export function getRouterByName(name: string): IContextRouter | undefined {
  return routerRegistry.get(name);
}

/** 查询已注册的 Router 名单（诊断/守卫用） */
export function listRouterNames(): string[] {
  return [...routerRegistry.keys()];
}

/**
 * 由 session 目录 / 会话 ID 推导渠道标识。
 * 会话 ID 形如 `<channel>_YYYYMMDD-HHMMSS-xxxx`；无前缀（纯 CLI 交互）回退 fallback。
 */
export function channelKeyOf(sessionDirOrId: string | undefined, fallback = 'tui'): string {
  if (!sessionDirOrId) return fallback;
  const base = sessionDirOrId.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const m = /^([a-z][a-z0-9-]*)_/.exec(base);
  return m ? m[1]! : fallback;
}

// ── 启动时注册内置 Router ──────────────────────────────────
registerRouter(new NormalRouter());
registerRouter(new CompanionRouter());
