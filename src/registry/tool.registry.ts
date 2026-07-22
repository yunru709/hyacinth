import { GenericRegistry, type RegistryItem } from './base.js';
import type { Tool } from '../tools/interface.js';
import type { ToolDefinition } from '../types.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { getActiveRouterName } from '../context/profiles.js';
import path from 'node:path';
import fs from 'node:fs';
import {
  createGetConfigTool,
  createUpdateConfigTool,
  createConfigSchemaTool,
  createResetConfigTool,
} from '../tools/config.js';
import {
  createSwitchProviderTool,
  createListProvidersTool,
  createProviderInfoTool,
  createSwitchToAutoRouteTool,
  createToggleToolTool,
  createListToolsTool,
  createToggleSkillTool,
  createListSkillsTool,
  createToggleSubAgentTool,
  createListSubAgentsTool,
  createSpawnSubAgentTool,
  createCreateSubAgentTool,
  createUpdateSubAgentTool,
  createListSubAgentTasksTool,
  createGetSubAgentResultTool,
  createInterruptTool,
  createSessionStatsTool,
  createCurrentSessionTool,
  createListSessionsTool,
  createNewSessionTool,
  createSwitchSessionTool,
  createDeleteSessionTool,
  createAllowToolTool,
  createDisallowToolTool,
  createListAllowlistTool,
  createAddTaskTool,
  createRemoveTaskTool,
  createListTasksTool,
  createToggleTaskTool,
  createMcpStatusTool,
  createListModelChannelsTool,
  createAddModelChannelTool,
  createRemoveModelChannelTool,
  createSetChannelRoleTool,
  createSetChannelModelTool,
  createResetChannelModelTool,
  createChannelInfoTool,
} from '../tools/runtime-control.js';

/** Tool 扩展 RegistryItem，增加可选的 source 字段 */
interface RegisteredTool extends Tool, RegistryItem {}

/**
 * 工具注册表
 * 负责注册、查询工具，以及生成 LLM 格式的工具定义
 * 继承自 GenericRegistry，复用通用增删改查逻辑
 */
export class ToolRegistry extends GenericRegistry<RegisteredTool> {
  /** 会话中热插拔添加的工具名集合。下次启动时清空，工具自然归位到 tool_rules。 */
  private hotAddedNames = new Set<string>();

  constructor() {
    super();
  }

  // ── 热插拔工具追踪 ──────────────────────────────────────────

  /** 标记工具为热插拔添加（会话临时）。调用方：hot-reload/tool-watcher.ts */
  markHotAdded(name: string): void {
    this.hotAddedNames.add(name);
  }

  /** 获取所有热插拔工具名（用于 Zone 5 session_tools 展示） */
  getHotAddedNames(): string[] {
    return [...this.hotAddedNames].sort();
  }

  /** 清空热插拔标记（下次启动时，所有工具自然都在 ToolRegistry 中） */
  clearHotAdded(): void {
    this.hotAddedNames.clear();
  }

  // ── LLM 工具定义 ──────────────────────────────────────────────

  /**
   * 生成 LLM 格式的工具定义数组
   * 用于发送给 LLM API，告知可用工具及其参数格式
   * 禁用的工具不会被包含。
   *
   * 陪伴模式下优先使用 companionDescription（拟人化描述），
   * 避免「退出陪伴模式」等人设冲突措辞。
   */
  getToolDefinitions(companionMode?: boolean): ToolDefinition[] {
    const isCompanion = companionMode ?? false;
    return this.getAll()
      .map((tool) => ({
        name: tool.name,
        description: isCompanion && tool.companionDescription
          ? tool.companionDescription
          : tool.description,
        input_schema: tool.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── 批量注册辅助方法 ──────────────────────────────────────────

  /**
   * 注册配置管理工具（get_config, update_config, config_schema, reset_config）
   */
  registerConfigTools(configCenter: RuntimeConfigCenter): void {
    this.register(createGetConfigTool(configCenter));
    this.register(createUpdateConfigTool(configCenter));
    this.register(createConfigSchemaTool(configCenter));
    this.register(createResetConfigTool(configCenter));
  }

  /**
   * 注册所有运行时控制工具（30+ tools）
   *
   * ⚠️ 新增运行时工具的正确方式：
   *   1. 在 src/tools/runtime-control.ts 中创建 createXxxTool() 工厂函数
   *   2. 在下方各分类段落中按类别注册
   *   3. 禁止在 factory.ts / loop.ts 中直接 new Tool() 硬编码
   *
   * Provider tools (4):
   *   switch_provider, list_providers, provider_info, switch_to_auto_route
   *
   * Registry control tools (9):
   *   toggle_tool, list_tools, toggle_skill, list_skills,
   *   toggle_sub_agent, list_sub_agents, spawn_sub_agent, create_sub_agent,
   *   update_sub_agent
   *
   * Session control tools (7):
   *   interrupt, session_stats, current_session, list_sessions, new_session, switch_session, delete_session
   *
   * Permission whitelist tools (3):
   *   allow_tool, disallow_tool, list_allowlist
   *
   * Schedule task management tools (4):
   *   add_task, remove_task, list_tasks, toggle_task
   */
  registerRuntimeControlTools(
    agentLoop: any,
    providerRouter: any,
    skillRegistry: any,
    agentRegistry: any,
    configCenter: any,
    cwd: string,
    heartbeatScheduler?: any,
    mcpSystem?: any,
    modelRouter?: any,
  ): void {
    // ── Provider tools (4) ──────────────────────────────────────────
    this.register(createSwitchProviderTool(agentLoop));
    this.register(createListProvidersTool(providerRouter));
    this.register(createProviderInfoTool(agentLoop));
    this.register(createSwitchToAutoRouteTool(agentLoop));

    // ── Model channel tools (4) ─────────────────────────────────────
    if (modelRouter) {
      this.register(createListModelChannelsTool(modelRouter));
      this.register(createAddModelChannelTool(modelRouter));
      this.register(createRemoveModelChannelTool(modelRouter));
      this.register(createSetChannelRoleTool(modelRouter));
      this.register(createSetChannelModelTool(modelRouter));
      this.register(createResetChannelModelTool(modelRouter));
      this.register(createChannelInfoTool(modelRouter));
    }

    // ── Registry control tools (8) ──────────────────────────────────
    this.register(createToggleToolTool(this, configCenter));
    this.register(createListToolsTool(this));
    this.register(createToggleSkillTool(skillRegistry, configCenter));
    this.register(createListSkillsTool(skillRegistry));
    this.register(createToggleSubAgentTool(agentRegistry, configCenter));
    this.register(createListSubAgentsTool(agentRegistry));
    this.register(createSpawnSubAgentTool(agentRegistry));
    this.register(createCreateSubAgentTool(agentRegistry, cwd));
    this.register(createUpdateSubAgentTool(agentRegistry));

    // ── 异步子 Agent 任务工具 (2) ─────────────────────────────────
    this.register(createListSubAgentTasksTool());
    this.register(createGetSubAgentResultTool());

    // destroy_sub_agent needs factory.ts sessionDir; register in factory.ts after loop is created
    // (handled by importing and registering createDestroySubAgentTool directly in factory.ts)

    // ── Session control tools (7) ────────────────────────
    this.register(createInterruptTool(agentLoop));
    this.register(createSessionStatsTool(agentLoop));
    this.register(createCurrentSessionTool(agentLoop));
    this.register(createListSessionsTool(agentLoop, cwd));
    this.register(createNewSessionTool(agentLoop, cwd));
    this.register(createSwitchSessionTool(agentLoop, cwd));
    this.register(createDeleteSessionTool(agentLoop, cwd));

    // ── MCP status tool ────────────────────────────────────────────
    if (mcpSystem) {
      this.register(createMcpStatusTool(mcpSystem));
    }

    // ── Permission whitelist tools (3) ───────────────────────────────
    if (configCenter) {
      this.register(createAllowToolTool(configCenter));
      this.register(createDisallowToolTool(configCenter));
      this.register(createListAllowlistTool(configCenter));
    }

    // ── Schedule task management tools (4) ───────────────────────────
    if (heartbeatScheduler) {
      // 自动检测当前 session 的渠道（从 meta.json 读取），
      // 这样模型无需手动指定 channel，任务自动归属到创建时的渠道。
      const getChannel = () => {
        try {
          const sessionDir: string | undefined = agentLoop?.sessionDir;
          if (sessionDir) {
            const metaPath = path.join(sessionDir, 'meta.json');
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              return (meta.channel as string) || undefined;
            }
          }
        } catch { /* 读取失败不阻塞 */ }
        return undefined;
      };
      // 自动检测当前 sessionId（多会话渠道如飞书需要此字段确定回复目标）
      const getSessionId = () => {
        try {
          const sessionDir: string | undefined = agentLoop?.sessionDir;
          if (sessionDir) {
            return path.basename(sessionDir);
          }
        } catch { /* 读取失败不阻塞 */ }
        return undefined;
      };
      // 自动检测当前模式（正常/陪伴），用于任务隔离
      const getMode = (): 'normal' | 'companion' | undefined => {
        const routerName = getActiveRouterName();
        if (routerName === 'companion') return 'companion';
        return 'normal';
      };
      this.register(createAddTaskTool(heartbeatScheduler, getChannel, getSessionId, getMode));
      this.register(createRemoveTaskTool(heartbeatScheduler, getMode));
      this.register(createListTasksTool(heartbeatScheduler, getMode));
      this.register(createToggleTaskTool(heartbeatScheduler, getMode));
    }
  }

  // ── 向后兼容别名 ──────────────────────────────────────────────

  /** @deprecated 使用 enable() 替代 */
  enableTool(name: string): void {
    this.enable(name);
  }

  /** @deprecated 使用 disable() 替代 */
  disableTool(name: string): void {
    this.disable(name);
  }
}