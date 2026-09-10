/**
 * session_fork —— 会话分支工具（A7）。
 *
 * 从源会话「回退到指定消息数之前的状态」创建全新会话，不破坏源会话。
 * 回滚语义从文件层（git 逐回合）升到完整状态层：fork 后 agent 从干净的原始
 * 上下文重新开始，源会话保留失败轨迹可复盘。
 */
import type { Tool } from './interface.js';
import type { AgentLoop } from '../orchestrator/loop.js';

/**
 * 创建 session_fork 工具。
 * @param agentLoop 用于读取当前会话目录（缺省 fork 当前会话）
 * @param cwd 项目目录（构造 SessionManager 用）
 */
export function createSessionForkTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'session_fork',
    description:
      '从某会话「回退到指定消息数之前的状态」创建全新会话（源会话不变，可反复分支）。' +
      '当长任务失败、需要回到某个决策点重试时使用：先 list_sessions 找到源会话，' +
      '再指定 keep_messages（保留源会话时间线前 N 条消息，含工具结果）。' +
      '新会话会剥离旧的压缩/簇标记，从原始上下文重新开始。创建后需用 switch_session 切换。',
    inputSchema: {
      type: 'object',
      properties: {
        source_session_id: {
          type: 'string',
          description: '源会话 ID。省略时默认使用当前会话。先用 list_sessions 查看。',
        },
        keep_messages: {
          type: 'number',
          description: '保留源会话前 N 条消息（从全量存档头部计，1..总条数）。回退点之后的全部内容将被丢弃。',
        },
      },
      required: ['keep_messages'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const { SessionManager, generateSessionId } = await import('../memory/session.js');
        const { materializeFork } = await import('../memory/fork.js');

        const sm = new SessionManager(cwd);
        const currentSessionDir = (agentLoop as any).sessionDir as string;
        const sourceId =
          (args.source_session_id as string | undefined) ?? path.basename(currentSessionDir);
        const keepMessages = Number(args.keep_messages);

        const sourceDir = sm.getSessionDir(sourceId);
        try {
          await fs.access(sourceDir);
        } catch {
          const sessions = await sm.list();
          return `Error: Session "${sourceId}" not found. Available sessions: ${sessions.map((s) => s.id).join(', ') || '(none)'}`;
        }

        const newId = generateSessionId('fork');
        const targetDir = sm.getSessionDir(newId);
        const result = await materializeFork(sourceDir, keepMessages, targetDir);

        await fs.writeFile(
          path.join(targetDir, 'meta.json'),
          JSON.stringify(
            {
              type: 'normal',
              createdAt: new Date().toISOString(),
              projectKey: sm.getProjectKey(),
              fork: {
                sourceSessionId: sourceId,
                keepMessages,
                forkedAt: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
          'utf-8',
        );

        return (
          `已从会话 ${sourceId} 回退到第 ${keepMessages}/${result.sourceCount} 条消息处，` +
          `创建新会话 ${newId}（写入 ${result.messageCount} 条原始消息，剥离 ${result.droppedMarkers} 个压缩/簇标记）。源会话未改动。\n\n` +
          `下一步：用 switch_session 切换 —— switch_session { "session_id": "${newId}" }`
        );
      } catch (err) {
        return `Error forking session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
