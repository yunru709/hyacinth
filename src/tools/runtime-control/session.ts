import type { Tool } from '../interface.js';
import type { AgentLoop } from '../../orchestrator/loop.js';

// Session / Training control tools (7)

/**
 * interrupt — interrupt the currently running agent loop.
 */
export function createInterruptTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'interrupt',
    description: '中断当前正在执行的 Agent 以及所有进行中的 LLM 请求。传入 instance_id 可精确中断指定子 Agent，不传则中断主 Agent。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: '可选：正在运行的子 Agent 的 instance ID。省略时中断主 Agent。',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const instanceId = args.instance_id as string | undefined;
        if (instanceId) {
          // 动态 import 避免循环依赖：runtime-control → delegate-tool → filtered-registry → tool.registry → runtime-control
          const { interruptSubAgentLoop } = await import('../../agents/delegate-tool.js');
          const ok = interruptSubAgentLoop(instanceId);
          return ok
            ? `Sub-agent "${instanceId}" interrupted.`
            : `No running sub-agent found with instance ID "${instanceId}". Use list_sub_agents to see available instances.`;
        }
        agentLoop.interrupt();
        return 'Agent execution interrupted.';
      } catch (err) {
        return `Error interrupting agent: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * current_session — show which session is currently active.
 */
export function createCurrentSessionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'current_session',
    description:
      '查看当前活跃会话信息：会话 ID、类型（normal/companion）、所属渠道和创建时间。在切换或列出会话之前，先确认自己当前在哪个会话中。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const fs = await import('node:fs');
        const sessionDir = (agentLoop as any).sessionDir as string;
        const sessionId = path.basename(sessionDir);

        // 读取 meta.json 获取 session 元信息
        let type = 'unknown';
        let channel: string | undefined;
        let createdAt = 'unknown';
        try {
          const metaPath = path.join(sessionDir, 'meta.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            type = meta.type ?? 'unknown';
            channel = meta.channel;
            createdAt = meta.createdAt ?? 'unknown';
          }
        } catch { /* meta.json may not exist for legacy sessions */ }

        const lines = [
          `Current session:`,
          `- ID: ${sessionId}`,
          `- Type: ${type}`,
          `- Channel: ${channel ?? '(none)'}`,
          `- Created: ${createdAt}`,
          `- Directory: ${sessionDir}`,
        ];

        if (channel) {
          lines.push(`\nThis session is bound to the "${channel}" channel. Use new_session to create a fresh session if needed.`);
        }

        return lines.join('\n');
      } catch (err) {
        return `Error getting current session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * session_stats — show current session statistics.
 */
export function createSessionStatsTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'session_stats',
    description: '查看当前会话的统计信息：轮次数、Token 使用量、压缩次数和上下文状态。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        // getTurnInfo requires current turnCount and tokensUsed.
        // Since we don't track these externally, use 0 as fallback.
        const info = agentLoop.getTurnInfo(0, 0);
        return JSON.stringify(info, null, 2);
      } catch (err) {
        return `Error getting session stats: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── Session management tools (4) ──

/**
 * list_sessions — list all existing sessions.
 */
export function createListSessionsTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'list_sessions',
    description: '列出所有会话，包含创建时间、类型和渠道信息。当前活跃会话标有 ← current。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const { SessionManager } = await import('../../memory/session.js');
        const sm = new SessionManager(cwd);
        // 只列**当前模式**的会话（会话与模式一一归属 ⇒ 列别的模式的会话
        // 只会诱使人去切、然后被拒 —— 白折腾一轮 ✗）
        const currentMode = agentLoop.activeRouter?.name ?? 'normal';
        const sessions = await sm.listByMode(currentMode);

        if (sessions.length === 0) {
          return `No sessions found in mode "${currentMode}". Use new_session to create one.`;
        }

        const currentSessionId = path.basename((agentLoop as any).sessionDir as string);

        const lines = sessions.map((s) => {
          const typeLabel = s.type ?? 'normal';
          const channelLabel = s.channel ? ` [${s.channel}]` : '';
          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ← current' : '';
          return (
            `${s.id}` +
            ` | created: ${s.createdAt}` +
            ` | updated: ${s.updatedAt}` +
            ` | type: ${typeLabel}${channelLabel}${marker}`
          );
        });

        return (
          `Sessions (${sessions.length} total, newest first):\n` +
          lines.map((l) => `  ${l}`).join('\n') +
          `\n\nUse switch_session to load a session, delete_session to remove one. ` +
          `⚠ The session marked "← current" is active and CANNOT be deleted.`
        );
      } catch (err) {
        return `Error listing sessions: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * new_session — create a brand-new session and switch to it immediately.
 */
export function createNewSessionTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'new_session',
    description:
      '创建新会话并立即切换。当前对话上下文将被清空。可选 channel 参数生成渠道前缀的会话 ID（如 tui / feishu / webui）。' +
      '可选 type 参数 = **模式名**（会话类型即模式，两者是同一个东西）—— 想要某个模式"自己的会话"就用它。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '可选：会话 ID 前缀所用的渠道名。省略时从当前会话自动检测。',
        },
        type: {
          type: 'string',
          description: '会话类型 = 模式名（任意已注册模式，见 switch_mode list）。缺省 "normal"。'
            + '新模式自己的会话就是这么起的：类型即模式，会话即该模式的隔离区。',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const { SessionManager } = await import('../../memory/session.js');
        const sm = new SessionManager(cwd);
        // 会话类型 = 模式（真源）。原先这里**写死 'normal'**（schema 也只允许 normal）
        // ⇒ 新模式永远起不了自己的会话，只能靠各自模式自己换目录绕过去 ✗
        const sessionType =
          typeof args.type === 'string' && args.type.trim() ? args.type.trim() : 'normal';
        let channel = (args.channel as string | undefined);

        const path = await import('node:path');
        const fs = await import('node:fs');

        // 自动检测当前 session 的渠道（飞书 → feishu, TUI → tui, WebUI → webui）
        if (!channel) {
          try {
            const currentSessionDir = (agentLoop as any).sessionDir as string;
            const metaPath = path.join(currentSessionDir, 'meta.json');
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              if (typeof meta.channel === 'string' && meta.channel.length > 0) {
                channel = meta.channel;
              }
            }
          } catch { /* 读取失败不阻塞 */ }
        }

        const session = await sm.create(sessionType, channel);
        const sessionDir = sm.getSessionDir(session.id);
        await agentLoop.switchSession(sessionDir);

        return (
          `New session created and activated:\n` +
          `- ID: ${session.id}\n` +
          `- Type: ${session.type}\n` +
          `- Channel: ${channel ?? '(auto: none detected)'}\n` +
          `- Created: ${session.createdAt}`
        );
      } catch (err) {
        return `Error creating new session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * switch_session — load and switch to an existing session.
 *
 * 注册链路：
 *   src/tools/runtime-control/（拆分后的目录）→ 工具实现
 *   → 注册到 ToolRegistry（factory.ts 中通过 registerRuntimeControlTools 调用）
 *   → tool_result 写入 conversation.jsonl（loop.ts append 阶段）
 *   → 出现在 Zone 3 (History) 的对话历史中
 *
 * ⚠️ tool_result 的文案会影响模型对当前会话状态的认知。
 *    如需修改返回文案，注意与 new_session、current_session 保持一致。
 */
export function createSwitchSessionTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'switch_session',
    description:
      '按会话 ID 切换到已有会话。当前对话上下文替换为目标会话的历史记录。先用 list_sessions 查看可用会话及其 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '要切换到的会话 ID（如 "tui-20260627-120000-abcd"）。用 list_sessions 查找 ID。',
        },
      },
      required: ['session_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const sessionId = args.session_id as string;
        const { SessionManager } = await import('../../memory/session.js');
        const sm = new SessionManager(cwd);
        const sessionDir = sm.getSessionDir(sessionId);

        // Verify the session directory exists
        const fsPromises = await import('node:fs/promises');
        try {
          await fsPromises.access(sessionDir);
        } catch {
          // 只报**本模式**的可用会话（列别的模式的没意义：切过去也会被拒 ✗）
          const ids = (await sm.listByMode(agentLoop.activeRouter?.name ?? 'normal'))
            .map((s) => s.id)
            .join(', ');
          return `Error: Session "${sessionId}" not found. Available sessions: ${ids || '(none)'}`;
        }

        await agentLoop.switchSession(sessionDir);
        return `当前会话为 ${sessionId}`;
      } catch (err) {
        return `Error switching session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * delete_session — permanently delete a session and its data.
 */
export function createDeleteSessionTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'delete_session',
    description:
      '永久删除指定会话及其全部对话数据，不可撤销。不能删除当前活跃的会话——需先切换到其他会话。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '要删除的会话 ID。用 list_sessions 查找 ID。不能是当前活跃会话。',
        },
        confirm: {
          type: 'boolean',
          description: '必须显式设为 true 以确认删除。',
        },
      },
      required: ['session_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const sessionId = args.session_id as string;
        const confirm = args.confirm as boolean | undefined;

        // 保护当前活跃 session
        const currentSessionId = path.basename((agentLoop as any).sessionDir as string);
        if (sessionId === currentSessionId) {
          return (
            `⚠ Cannot delete the currently active session "${sessionId}". ` +
            `Use switch_session to switch to a different session first, then retry deletion.`
          );
        }

        if (confirm !== true) {
          return (
            `⚠ This will permanently delete session "${sessionId}" and all its data. ` +
            `This cannot be undone.\n` +
            `To confirm, call delete_session again with session_id="${sessionId}" and confirm=true.`
          );
        }

        const { SessionManager } = await import('../../memory/session.js');
        const sm = new SessionManager(cwd);
        const sessionDir = sm.getSessionDir(sessionId);

        const fsPromises = await import('node:fs/promises');
        try {
          await fsPromises.access(sessionDir);
        } catch {
          return `Session "${sessionId}" not found (may have been already deleted).`;
        }

        await fsPromises.rm(sessionDir, { recursive: true, force: true });
        return `Session "${sessionId}" deleted.`;
      } catch (err) {
        return `Error deleting session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
