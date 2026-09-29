// ============================================================
// 模式切换编排 —— 唯一实现
// ============================================================
// 「已激活 → 重放生命周期；未激活 → syncRouter」这套切换编排放收敛于此，
// companion_mode 工具 / ui-protocol companion 域 / context.mode 插件服务
// 全部委托它，不再各抄一份（历史事故：三处人肉对齐，改一处漏两处）。
//
// 模式真源 = session type：切换最终经 loop.syncRouter(mode) 落地，
// 由目标 Router 的 onActivate 切到对应类型的 session。
// ============================================================

import { getRouterByName } from './profiles.js';
import { SESSION_TYPE_NORMAL } from '../types.js';

/** 可切换模式的 loop 最小面（AgentLoop 子集） */
export interface ModeSwitchLoopLike {
  /** 当前激活 Router */
  activeRouter?: {
    name: string;
    onDeactivate?(loop: unknown): Promise<void>;
  };
  /** 按名切换 Router（显式目标） */
  syncRouter(target?: string): Promise<void>;
  /**
   * 配置读取的公开窄面（可选）：用来读默认模式 `startup.defaultMode`。
   * 注意**不能**叫 `configCenter` —— AgentLoop 的同名字段是 private，结构类型会撞 ✗
   * （tsc 已报过：Property 'configCenter' is private in type 'AgentLoop'）。
   */
  getConfigValue?(key: string): unknown;
}

export interface ModeSwitchResult {
  /** 切换是否执行（false = 目标模式本就激活且参数未变化） */
  performed: boolean;
}

/** 内置兜底模式：没有任何配置时"退出"回到这里 */
export const BUILTIN_DEFAULT_MODE: string = SESSION_TYPE_NORMAL;

/**
 * 「退出当前模式 → 回到哪个模式」的唯一判定。
 *
 * 为什么要有它：模式的**出口**原先在三个调用点各自写死「回正常模式」✗ ——
 * 一旦模式不止两个（coding / test / …），那些点名会逐个失效，而且没人会记得改。
 * 现在只在这里判一次：读**配置的默认模式**（startup.defaultMode），缺省回退内置模式。
 *
 * 自退出守卫：解析结果若等于当前模式（比如用户把启动默认设成了陪伴），
 * 再"退出"就成了原地重进 ⇒ 此时回退到内置模式。
 */
export function resolveExitMode(currentMode?: string, configuredDefault?: unknown): string {
  if (
    typeof configuredDefault === 'string'
    && configuredDefault.length > 0
    && configuredDefault !== currentMode
  ) {
    return configuredDefault;
  }
  return BUILTIN_DEFAULT_MODE;
}

/** 统一出口：切回默认模式（等价 switchToMode(loop, null)） */
export async function exitToDefaultMode(loop: ModeSwitchLoopLike): Promise<ModeSwitchResult> {
  return switchToMode(loop, null);
}

/**
 * 切到指定模式（统一编排）。**进与出都走这里** —— 模式切换的唯一入口。
 *
 * - 未激活：设好模式参数后 `loop.syncRouter(mode)`（自动 onDeactivate → 切换 → onActivate）。
 * - 已激活：Router 参数（如陪伴角色名）已就地更新，但 syncRouter 同名检测会直接
 *   return —— 手动重放 `onDeactivate → onActivate` 使参数生效。
 * - 调用方自行处理「已激活且参数相同 → 幂等返回」的快速路径（参数语义模式自知）。
 * - **`mode = null` = 回默认模式**（见 resolveExitMode）：调用点不必知道"默认"是哪个模式。
 * - 未注册的模式名会**抛错并列出已注册模式** —— 比 `loop.syncRouter()` 的
 *   "静默停在旧模式"可诊断得多（这也是"切换必须走这里"的理由之一）。
 *
 * @param params 直接写到 Router 实例上的模式参数（如 `{ activeCompanionName: '柔柔' }`）
 */
export async function switchToMode(
  loop: ModeSwitchLoopLike,
  mode: string | null,
  params?: Record<string, unknown>,
): Promise<ModeSwitchResult> {
  const target =
    mode ?? resolveExitMode(loop.activeRouter?.name, loop.getConfigValue?.('startup.defaultMode'));

  const router = getRouterByName(target);
  if (!router) {
    const { listRouterNames } = await import('./profiles.js');
    throw new Error(`Unknown mode: ${target}. Registered: ${listRouterNames().join(', ')}`);
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      (router as unknown as Record<string, unknown>)[k] = v;
    }
  }

  if (loop.activeRouter?.name === target) {
    // 已激活：参数已就地更新，重放生命周期使其生效
    await loop.activeRouter.onDeactivate?.(loop);
    await router.onActivate?.(loop);
    return { performed: true };
  }

  await loop.syncRouter(target);
  return { performed: true };
}
