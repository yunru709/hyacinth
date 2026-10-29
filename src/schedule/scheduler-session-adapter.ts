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
    // 【loop 统一 2026-10-28】先查「开着的 UI loop」注册表：命中 ⇒ 复用标签 loop（同一个 loop，
    // 不再重复建 ⇒ 不抢 sessionDir 锁）。标签 loop 的 outputHandler 是 ProtocolOutputHandler，
    // 结果经 WS 推给开着的标签（+ webui 前端播 say），无需 collectHandler/主机播放。
    try {
      const { getOpenLoop } = await import('../loop-registry.js');
      const openLoop = getOpenLoop(channel, sessionId) as {
        notifyTaskFired?: (n: string) => Promise<void>;
        run?: (i: string) => Promise<void>;
      } | null;
      if (openLoop) {
        const runTask = (n: string) =>
          openLoop.notifyTaskFired
            ? openLoop.notifyTaskFired(n)
            : openLoop.run
              ? openLoop.run(`[Scheduled Task] "${n}" triggered.`)
              : Promise.resolve();
        return { runTask, runPrompt, getResponse: () => '' };
      }
    } catch {
      /* 注册表查询失败 → 落回新建 */
    }
    const entry = await sessionService.getOrCreateLoop(channel, sessionId);
    // ⚠️ 2026-10-28：临时/后台 loop 的 collectHandler **没有 onEvent**（createCollectHandler 只实现了
    // onText/onTurnStart 等），而 say 的音频是 `notify = this.outputHandler?.onEvent?.(...)` 发出的
    // （loop.ts）⇒ SAY_VOICE 音频事件被静默丢弃 ⇒ 一次性任务 say 无声。
    // 给它补挂 onEvent：捕获 tts.say_voice 的 audioWavBase64，用主机 SoundPlayer 播放（与 tui.ts 同法）。
    const ch = entry.collectHandler as unknown as { onEvent?: (type: string, payload?: unknown) => void };
    if (typeof ch.onEvent !== 'function') {
      ch.onEvent = (type, payload) => {
        if (type !== 'tts.say_voice') return;
        const p = payload as { state?: string; audioWavBase64?: string } | undefined;
        if (!p || p.state !== 'ready' || typeof p.audioWavBase64 !== 'string') return;
        const b64 = p.audioWavBase64;
        void (async () => {
          try {
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const { spawn } = await import('node:child_process');
            const os = await import('node:os');
            const dir = path.join(os.homedir(), '.agent', 'work', 'say-cache');
            mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
            writeFileSync(file, Buffer.from(b64, 'base64'));
            spawn(
              'powershell',
              ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
                `$p='${file}'; try { (New-Object Media.SoundPlayer $p).PlaySync() } finally { Remove-Item $p -ErrorAction SilentlyContinue }`],
              { stdio: 'ignore', windowsHide: true },
            ).on('error', () => { /* spawn 失败忽略 */ });
          } catch (err) {
            console.error('[scheduler-adapter] say host playback failed', err);
          }
        })();
      };
    }
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
      return {
        notifyTaskFired: async (n: string) => {
          try {
            await h.runTask(n);
          } finally {
            // 2026-10-29「拉起跑完自动释放」：任务跑完，若该会话**当前没有开着的标签**，
            // 就释放为它恢复的后台 loop（会话磁盘历史不动，下次打开 getOrCreateLoop 会重建）。
            // 命中注册表(标签开着)的情况**不释放**——那是标签自己的 loop。
            const { getOpenLoop } = await import('../loop-registry.js');
            if (!getOpenLoop(channel, sessionId)) {
              try {
                sessionService.removeLoop(channel, sessionId);
              } catch {
                /* 幂等：loop 可能已不在 */
              }
            }
          }
        },
      };
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
              // ⚠️ 2026-10-28 修：content 必须是**块数组**（conversation 正常格式）；存成字符串会让下游
              // composer.ts `for (const b of content)` 逐字符遍历 + `'cache_control' in b` 抛
              // "Cannot use 'in' operator ... in [定时任务…]"——重启加载该会话即崩。
              content: [{ type: 'text', text: `[定时任务 ${taskName}]\n${output}` }],
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
