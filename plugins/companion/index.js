/**
 * companion 目录插件 —— 陪伴模式聚合（注册式，监督层目录插件）。
 *
 * 用户把本目录放到 <project>/plugins/companion/（内置插件，随代码分发；也可放
 * <project>/.agent/plugins/companion/，用户级安装）并在插件表注册后，
 * 陪伴模式即随插件启停 —— 无需改动内核代码。
 *
 * 依赖（统一宿主下同 PluginHost，deps 校验 + getService 取服务）：
 *   - bypass（内核基座）：提供 bypass.manager（BypassManager）
 *   - world-engine.createAgent（内核能力服务）：世界引擎工厂 —— 实现类留在
 *     内核库，本插件经工厂创建并驱动世界引擎（世界引擎不再是内核插件，不被
 *     无条件 mount，仅随陪伴插件启停）
 *   - context.mode（内核能力服务）：模式切换窄接口（companion Router + 角色回填）
 *
 * ⚠️ 安全红线：世界引擎工具面只含 WORLD_TOOLS（窄工具），由内核保证；
 * 本插件只做编排（注册/激活/切换），不触碰工具注册。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LAST_CHARACTER = path.join(os.homedir(), '.agent', 'companion', '.last-character');

function readLastCharacter() {
  try {
    const last = fs.readFileSync(LAST_CHARACTER, 'utf-8').trim();
    return last || '';
  } catch {
    return '';
  }
}

/** 本插件经工厂创建的世界引擎（卸载时据此摘除） */
let registeredAgent = null;

export default {
  id: 'companion',
  name: '陪伴模式',
  description: '陪伴模式聚合：世界引擎 + 陪伴旁路 agent 配置 + 角色 Router 恢复',

  /** 目录插件必需入口（能力注册；陪伴模式能力在 onActivate 编排） */
  register: () => {},

  async onActivate(api) {
    const config = api.getConfig();
    const autoActivate = config.autoActivate !== false;
    // 显式配置角色（含空串 = 禁用世界引擎）优先；未配置时读 .last-character
    const characterName = config.characterName !== undefined
      ? config.characterName
      : readLastCharacter();

    const bypassManager = api.getService('bypass.manager');
    const createAgent = api.getService('world-engine.createAgent');
    const contextMode = api.getService('context.mode');

    // ── 世界引擎：经内核工厂创建并注册（插件持有世界引擎装配/驱动） ──
    if (characterName && createAgent && bypassManager) {
      const worldAgent = createAgent(characterName);
      bypassManager.register(worldAgent);
      registeredAgent = worldAgent;
      // 暴露实例服务（router / UI 层经 loop.pluginHost 取用；卸载自动回滚）
      api.registerService('world-engine.agent', worldAgent);
    }

    // ── 陪伴模式激活：切 Router + 回填角色 + 激活旁路模式 ──
    if (contextMode) {
      contextMode.activateCompanion(characterName);
    }
    if (autoActivate && bypassManager) {
      await bypassManager.activateForMode('companion').catch(() => {});
    }

    api.logger.info('companion mode activated', {
      character: characterName,
      worldAgent: !!registeredAgent,
    });
  },

  async onDeactivate(api) {
    const bypassManager = api.getService('bypass.manager');
    const contextMode = api.getService('context.mode');

    // 摘除本插件创建的世界引擎（registry 移除；world-engine.agent 服务随 ctx 自动回滚）
    if (registeredAgent && bypassManager) {
      bypassManager.unregister(registeredAgent.name);
      registeredAgent = null;
    }
    // 退出陪伴模式（停用旁路 agent + 切回 normal Router）
    if (bypassManager) {
      await bypassManager.deactivateAll().catch(() => {});
    }
    if (contextMode) {
      contextMode.deactivateCompanion();
    }
    api.logger.info('companion mode deactivated');
  },
};
