// 定时任务会话端口适配器（2026-10-28）
//
// 在 gateway 层（server.ts）把 SessionService/SessionManager 的会话能力，适配成
// schedule 层的窄接口 SchedulerSessionPort，并注册为进程级单例（setSchedulerSessionPort）。
// schedule 侧 handler 通过 getSchedulerSessionPort() 读取 —— 不穿透 factory/agent-assembly 多层。
//
// v1 取舍（已在桌面 handoff 文档记录）：
//  - broadcastOpenSession = no-op（UiProtocolServer 非全局单例，暂无可跨标签广播"开标签"的对象；
//    任务结果落在目标会话 history，用户重开该会话即见）。
//  - createEphemeralSession 先只建会话（列表隐藏 ephemeral 待补 meta 标记）。

import { rm } from 'node:fs/promises';
import { setSchedulerSessionPort } from '../schedule/session-port.js';
import type { SchedulerSessionPort } from '../schedule/session-port.js';
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
      // v1 no-op（见文件头说明）
    },
  };

  setSchedulerSessionPort(port);
}
