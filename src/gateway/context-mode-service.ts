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

/** 模式切换所需的最小 loop 面（AgentLoop 的子集） */
export interface ModeLoopLike {
  /** 当前激活 Router 名 */
  readonly activeRouter: { readonly name: string };
  /** 按名切换 Router（显式目标） */
  syncRouter(target?: string): Promise<void>;
}

/** context.mode 服务面（注册到统一 PluginHost 服务表，插件经 getService 取用） */
export interface ContextModeService {
  /** 切入指定模式；陪伴模式可回填角色名 */
  activateMode(mode: string, opts?: { characterName?: string }): Promise<void>;
  /** 切入陪伴模式并回填角色名（兼容旧名） */
  activateCompanion(characterName: string): Promise<void>;
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
