// 定时任务会话端口适配器（2026-10-28）
//
// ⚠️ 放在 schedule 层（业务核心）：因为它需要 `import { setSchedulerSessionPort }`
// （schedule 的值导入）。若放 gateway/（UI 层）会违反 verify:layers 规则5「UI 不得直连业务核心」。
// SessionService / SessionManager 只 `import type`（靠注入实例，不做静态运行时依赖）。
//
// 在 gateway 层（server.ts）调用 installSchedulerSessionPort({sessionManager, sessionService}) 注册。
// v1 取舍（见桌面 handoff）：broadcastOpenSession=no-op；createEphemeralSession 先只建会话。

import { rm } from 'node:fs/promises';
import { setSchedulerSessionPort } from './session-port.js';
import type { SchedulerSessionPort } from './session-port.js';
import type { SessionService } from '../session-service.js';
import type { SessionManager } from '../memory/session.js';

export function installSchedulerSessionPort(deps: {
  sessionManager: SessionManager;
  sessionService: SessionService;
}): void {
  const { sessionManager, sessionService } = deps;

  const port: SchedulerSessionPort = {
    async getOrCreateLoop(channel, sessionId) {
      const entry = await sessionService.getOrCreateLoop(channel, sessionId);
      const loop = entry.loop as unknown as {
        notifyTaskFired?: (n: string) => Promise<void>;
        run: (i: string) => Promise<void>;
      };
      return {
        notifyTaskFired: (n) =>
          loop.notifyTaskFired
            ? loop.notifyTaskFired(n)
            : loop.run(`[Scheduled Task] "${n}" triggered.`),
      };
    },

    async createEphemeralSession(channel) {
      const s = await sessionManager.create('normal', channel, { lazy: false });
      return { sessionId: s.id };
    },

    async destroySession(channel, sessionId) {
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
    },

    broadcastOpenSession() {
      // v1 no-op（UiProtocolServer 非全局单例，暂无可跨标签广播"开标签"的对象）
    },
  };

  setSchedulerSessionPort(port);
}
