// 定时任务会话端口适配器（2026-10-28）
//
// ⚠️ 放在 schedule 层（业务核心）：因为它需要 `import { setSchedulerSessionPort }`
// （schedule 的值导入）。若放 gateway/（UI 层）会违反 verify:layers 规则5「UI 不得直连业务核心」。
// SessionService / SessionManager / ConversationStore 只 `import type` 或用注入实例，不做 gateway 静态依赖。
//
// 在 gateway 层（server.ts）调用 installSchedulerSessionPort({sessionManager, sessionService}) 注册。
// v1 取舍（见桌面 handoff）：broadcastOpenSession=no-op（UiProtocolServer 非全局，暂无法跨标签广播）。

import { rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setSchedulerSessionPort } from './session-port.js';
import type { SchedulerSessionPort } from './session-port.js';
import type { SessionService } from '../session-service.js';
import type { SessionManager } from '../memory/session.js';
import { ConversationStore } from '../memory/conversation.js';

export function installSchedulerSessionPort(deps: {
  sessionManager: SessionManager;
  sessionService: SessionService;
}): void {
  const { sessionManager, sessionService } = deps;

  // 销毁会话：摘 loop + 删目录（幂等）
  const destroySession = async (channel: string, sessionId: string): Promise<void> => {
    try {
      sessionService.removeLoop(channel, sessionId);
    } catch {
      /* 幂等：loop 可能已不在 */
    }
    try {
      await rm(sessionManager.getSessionDir(sessionId), { recursive: true, force: true });
    } catch {
      /* 幂等：目录可能已删 */
    }
  };

  // 建临时会话 + 标记 ephemeral（列表过滤用；readSessionAt 会读 meta.ephemeral）
  const createEphemeral = async (channel: string): Promise<string> => {
    const s = await sessionManager.create('normal', channel, { lazy: false });
    try {
      const metaPath = path.join(sessionManager.getSessionDir(s.id), 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      meta.ephemeral = true;
      await writeFile(metaPath, JSON.stringify(meta), 'utf-8');
    } catch {
      /* meta 写失败不致命：只是列表可能短暂可见 */
    }
    return s.id;
  };

  const getLoop = async (channel: string, sessionId: string) => {
    const entry = await sessionService.getOrCreateLoop(channel, sessionId);
    const loop = entry.loop as unknown as {
      notifyTaskFired?: (n: string) => Promise<void>;
      run: (i: string) => Promise<void>;
    };
    const runTask = (n: string) =>
      loop.notifyTaskFired ? loop.notifyTaskFired(n) : loop.run(`[Scheduled Task] "${n}" triggered.`);
    const getResponse = () => (entry.collectHandler as unknown as { getResponse?: () => string })?.getResponse?.() ?? '';
    return { runTask, getResponse };
  };

  const port: SchedulerSessionPort = {
    async getOrCreateLoop(channel, sessionId) {
      const h = await getLoop(channel, sessionId);
      return { notifyTaskFired: (n) => h.runTask(n) };
    },

    async createEphemeralSession(channel) {
      const sessionId = await createEphemeral(channel);
      return { sessionId };
    },

    async destroySession(channel, sessionId) {
      await destroySession(channel, sessionId);
    },

    broadcastOpenSession() {
      // v1 no-op（UiProtocolServer 非全局单例，暂无可跨标签广播"开标签"的对象）
    },

    async runOneShot({ channel, taskName, deliverSessionId }) {
      const ephId = await createEphemeral(channel);
      try {
        const h = await getLoop(channel, ephId);
        await h.runTask(taskName);
        // ⚠️ getResponse() 取到的是临时会话「末轮」文本；而 say 不结束回合、agent 会继续多轮
        // ⇒ getResponse 拿到的是困惑叙述（"没有新的任务指令…"），不是那句台词（2026-10-28 实测）。
        // 改为从临时会话 conversation.jsonl 里提取「say 工具」的 input.content 作为交付内容。
        let output = '';
        try {
          const convoPath = path.join(sessionManager.getSessionDir(ephId), 'conversation.jsonl');
          const convo = await readFile(convoPath, 'utf-8');
          for (const ln of convo.split('\n')) {
            if (!ln.trim()) continue;
            try {
              const m = JSON.parse(ln) as { content?: unknown };
              const arr = Array.isArray(m.content) ? m.content : [m.content];
              for (const c of arr as Array<{ type?: string; name?: string; input?: { content?: unknown } }>) {
                if (c && c.type === 'tool_use' && c.name === 'say' && typeof c.input?.content === 'string') {
                  output = c.input.content.trim(); // 取最后一处 say 的台词
                }
              }
            } catch {
              /* 单行坏，跳过 */
            }
          }
        } catch {
          /* 读不到 conversation */
        }
        if (!output) output = h.getResponse().trim(); // 兜底：退回归档文本
        if (deliverSessionId && output) {
          try {
            await new ConversationStore().append(sessionManager.getSessionDir(deliverSessionId), {
              role: 'assistant',
              content: `[定时任务 ${taskName}]\n${output}`,
            } as never);
          } catch {
            /* 交付失败不阻断销毁 */
          }
        }
      } finally {
        const sid = ephId;
        setTimeout(() => void destroySession(channel, sid), 5 * 60_000);
      }
    },
  };

  setSchedulerSessionPort(port);
}
