/**
 * context-mode-service.ts —— 上下文模式服务面（context.mode）。
 *
 * 供目录插件（如 companion 聚合插件）编排模式切换：插件经
 * api.getService('context.mode') 取得，不再直接 import profiles（内核内部）。
 *
 * 模式真源 = session type：切换即 loop.syncRouter(mode)，由目标 Router 的
 * onActivate 完成对应类型 session 的切换。服务绑定主 loop（装配期注入）。
 */
import { switchToMode } from '../context/mode-switch.js';
import { getRouterByName } from '../context/profiles.js';

/** 模式切换所需的最小 loop 面（AgentLoop 的子集） */
export interface ModeLoopLike {
  /** 当前激活 Router 名 */
  readonly activeRouter: { readonly name: string };
  /**
   * 当前会话类型 —— **模式真源**（`AgentLoop.sessionType` 的公开窄面）。
   * `syncToSessionType()` 靠它决定"该在哪个模式"；可选（缺省按 normal 处理）。
   */
  readonly sessionType?: string;
  /** 按名切换 Router（显式目标） */
  syncRouter(target?: string): Promise<void>;
}

/** context.mode 服务面（注册到统一 PluginHost 服务表，插件经 getService 取用） */
export interface ContextModeService {
  /** 切入指定模式；陪伴模式可回填角色名 */
  activateMode(mode: string, opts?: { characterName?: string }): Promise<void>;
  /** 切入陪伴模式并回填角色名（兼容旧名） */
  activateCompanion(characterName: string): Promise<void>;
  /**
   * 让模式**跟随会话类型**（模式真源 = session type）：会话类型是什么就对齐到什么。
   *
   * 与 `activateMode` 的区别：那个是"我要求进某模式"（用户/工具显式意图），
   * 这个是"按这个会话该在的模式对齐"。典型用途：插件在**激活时**对齐一次 ——
   * 默认 normal 会话就是空操作，**不会把「启动默认模式」这个设置覆盖掉**。
   * （2026-10-16 事故：插件无条件 activateCompanion ⇒ config=normal 也被带进陪伴。）
   *
   * @param params 同 switchToMode：直接写到**目标 Router** 实例上（如 { activeCompanionName }）
   */
  syncToSessionType(params?: Record<string, unknown>): Promise<void>;
  /** 回默认模式（默认哪个模式由 mode-switch 判定，不在此写死） */
  deactivateCompanion(): Promise<void>;
  /** 当前是否为指定模式（通用：伴随模式的候选名不再写死在这层） */
  isModeActive(mode: string): boolean;
  /** 当前是否陪伴模式（isModeActive('companion') 的兼容别名） */
  isCompanionActive(): boolean;
}

/** 创建 context.mode 服务（绑定主 loop；按 session type 真源切换） */
export function createContextModeService(loop: ModeLoopLike): ContextModeService {
  return {
    async activateMode(mode, opts) {
      await switchToMode(loop, mode, opts?.characterName ? { activeCompanionName: opts.characterName } : undefined);
    },
    async activateCompanion(characterName) {
      await this.activateMode('companion', { characterName });
    },
    async syncToSessionType(params) {
      const target = loop.sessionType ?? 'normal';
      if (params) {
        const router = getRouterByName(target);
        if (router) {
          for (const [k, v] of Object.entries(params)) {
            (router as unknown as Record<string, unknown>)[k] = v;
          }
        }
      }
      // 无参 syncRouter = 跟随 loop 的 session type（未注册的模式名会静默保持现状）
      await loop.syncRouter();
    },
    async deactivateCompanion() {
      // 统一出口：null = 回默认模式
      await switchToMode(loop, null);
    },
    isModeActive(mode) {
      return loop.activeRouter?.name === mode;
    },
    isCompanionActive() {
      return this.isModeActive('companion');
    },
  };
}
