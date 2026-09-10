/**
 * context-mode-service.ts —— 上下文模式服务面（context.mode）。
 *
 * 供目录插件（如 companion 聚合插件）编排模式切换：插件经
 * api.getService('context.mode') 取得，不再直接 import profiles（内核内部）。
 *
 * 窄接口设计：只暴露陪伴模式相关的切换/查询，避免把全局 Router 原语
 * （switchRouter 等）全量交给插件 —— 满足「监督层为插件准备好足够优秀
 * 的接口」且接口面收敛（可插拔接口稳定原则）。
 */
import { switchRouter, getActiveRouterName } from '../context/profiles.js';

/** context.mode 服务面（注册到统一 PluginHost 服务表，插件经 getService 取用） */
export interface ContextModeService {
  /** 切入陪伴模式并回填角色名 */
  activateCompanion(characterName: string): void;
  /** 切回正常模式 */
  deactivateCompanion(): void;
  /** 当前是否陪伴模式 */
  isCompanionActive(): boolean;
}

/** 创建 context.mode 服务（基于 profiles 的全局 Router） */
export function createContextModeService(): ContextModeService {
  return {
    activateCompanion(characterName) {
      const companionRouter = switchRouter('companion');
      if (characterName) {
        (companionRouter as unknown as Record<string, unknown>).activeCompanionName = characterName;
      }
    },
    deactivateCompanion() {
      switchRouter('normal');
    },
    isCompanionActive() {
      return getActiveRouterName() === 'companion';
    },
  };
}
