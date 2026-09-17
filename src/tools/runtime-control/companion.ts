import type { Tool } from '../interface.js';
import type { AgentLoop } from '../../orchestrator/loop.js';
import type { CompanionSessionManager } from '../../memory/companion-session.js';
import { clearPromptCache } from '../../prompts/loader.js';
import { switchRouter, switchRouterForChannel } from '../../context/profiles.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 陪伴模式工具 (2)

/** 生成最小默认 world-engine.json（activate 缺配置 / create 时共用；不依赖外部模板） */
function defaultWorldEngineConfig(charName: string): Record<string, unknown> {
  return {
    enabled: true,
    worldName: '我们的世界',
    companion: { name: charName, desc: '' },
    ticker: {
      heartbeatMs: 5000,
      timeScale: 1,
      weatherAvgHours: 4,
      overcastHoursBeforeRain: 1.5,
    },
  };
}

/**
 * companion_mode — 陪伴模式切换（进入 / 退出）。
 */
export function createCompanionModeTool(
  agentLoop: AgentLoop,
  companionSessionManager: CompanionSessionManager,
): Tool {
  return {
    name: 'companion_mode',
    description:
      '陪伴模式开关与角色管理（只有此工具能做到）。' +
      '用户请求中出现的角色名必须填入 name 参数；没有角色名才省略。' +
      'action="activate"进入陪伴，action="create"新建角色并激活，action="deactivate"退出陪伴。' +
      '触发词：进入/退出/切换陪伴、找人聊天、创造角色。',
    companionDescription:
      '他离开了，道个别。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['activate', 'create', 'deactivate'],
          description: 'activate=进入陪伴, create=新建角色并激活, deactivate=退出陪伴',
        },
        name: {
          type: 'string',
          description: '角色名。只要用户提到了就填进来，完全没提才可省略。',
        },
        persona: {
          type: 'string',
          description: '角色人设/性格描述（仅在 create 时需要），将写入 persona.md',
        },
        memory: {
          type: 'string',
          description: '初始记忆文本（仅在 create 时需要，可选），将写入 memory.md',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args.action as string;
      const loop = agentLoop;

      try {
        switch (action) {
          case 'activate': {
            // 列出所有可用角色（= companion 下每个有 persona.md 的目录）
            const companionRoot = path.join(os.homedir(), '.agent', 'companion');
            const availableChars: string[] = (() => {
              try {
                return fs.readdirSync(companionRoot, { withFileTypes: true })
                  .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                  .map(e => e.name)
                  .filter(n => fs.existsSync(path.join(companionRoot, n, 'persona.md')));
              } catch { return []; }
            })();

            // 确定目标角色名
            const charName: string | null = (() => {
              if (typeof args.name === 'string' && args.name.trim()) return args.name.trim();
              if (availableChars.length === 1) return availableChars[0];
              if (availableChars.length === 0) return null;
              // 多个可用 → 优先上次用过的
              try {
                const last = fs.readFileSync(path.join(companionRoot, '.last-character'), 'utf-8').trim();
                if (last && availableChars.includes(last)) return last;
              } catch {}
              return availableChars[0];
            })();

            if (!charName) {
              return '还没有创建任何陪伴角色。请用 companion_mode action="create" 来创建第一个角色。';
            }

            const charDir = path.join(os.homedir(), '.agent', 'companion', charName);
            const personaFile = path.join(charDir, 'persona.md');
            if (!fs.existsSync(personaFile)) {
              const hint = availableChars.length
                ? `当前已有角色：${availableChars.join('、')}`
                : '当前还没有任何角色';
              return [
                `角色「${charName}」尚未创建。${hint}。`,
                '请向用户确认以下信息后，用 companion_mode action="create" 来初始化：',
                '  - persona：角色人设/性格描述（必填）',
                '  - memory：初始记忆（可选，如角色背景故事、关键关系等）',
                '用户确认后你直接调 create，写完后会自动激活。',
              ].join('\n');
            }

            // 角色存在但缺少 world-engine.json → 自动生成最小默认配置
            const charConfig = path.join(charDir, 'world-engine.json');
            if (!fs.existsSync(charConfig)) {
              fs.writeFileSync(charConfig, JSON.stringify(defaultWorldEngineConfig(charName), null, 2), 'utf-8');
            }

            // 拿到 CompanionRouter 单例
            const companionRouter = switchRouterForChannel(loop.channelKey, 'companion');

            if (loop.activeRouter.name === 'companion') {
              // 已在陪伴模式 → 同角色提示，不同角色手动 deactivate→activate
              const currentName = (loop.activeRouter as any).activeCompanionName || '';
              if (currentName === charName) {
                clearPromptCache();
                return `已在情感陪伴模式（${charName}）中 💫`;
              }
              await loop.activeRouter.onDeactivate?.(loop);
              (companionRouter as any).activeCompanionName = charName;
              await companionRouter.onActivate?.(loop);
            } else {
              // 从正常模式进入 → 设名字后 syncRouter 自动触发 onActivate
              (companionRouter as any).activeCompanionName = charName;
              await loop.syncRouter();
            }
            clearPromptCache();

            // 记住本次选择，下次不指定名称时自动用
            try {
              fs.writeFileSync(
                path.join(os.homedir(), '.agent', 'companion', '.last-character'),
                charName, 'utf-8'
              );
            } catch { /* 写入失败不影响激活 */ }

            return `已切换到情感陪伴模式（${charName}）💫 现在可以放松聊天了。想退出时告诉我就好。`;
          }

          case 'create': {
            const charName = typeof args.name === 'string' && args.name.trim()
              ? args.name.trim()
              : null;
            if (!charName) return '请提供角色名（name 参数）。';
            // 角色名会拼进 ~/.agent/companion/{name}/ 目录，必须白名单校验防路径穿越
            if (!/^[a-zA-Z0-9_\-]+$/.test(charName)) {
              return '角色名不合法：仅允许字母、数字、下划线和连字符（如 "xiaoya"）。请换一个名字。';
            }

            const persona = typeof args.persona === 'string' && args.persona.trim()
              ? args.persona.trim()
              : null;
            if (!persona) return '请提供角色人设（persona 参数），这是必填的。可以请用户描述这个角色的性格、背景、说话方式等。';

            const memory = typeof args.memory === 'string' && args.memory.trim()
              ? args.memory.trim()
              : null;

            // 创建角色目录与文件
            const charDir = path.join(os.homedir(), '.agent', 'companion', charName);

            // 角色已存在 → 拒绝覆盖，提示用 activate
            if (fs.existsSync(path.join(charDir, 'persona.md'))) {
              return `角色「${charName}」已存在。若要切换到此角色，请用 companion_mode action="activate" name="${charName}"。`;
            }

            fs.mkdirSync(charDir, { recursive: true });
            fs.writeFileSync(path.join(charDir, 'persona.md'), persona, 'utf-8');
            if (memory) {
              fs.writeFileSync(path.join(charDir, 'memory.md'),
                `# ${charName} 的记忆\n\n${memory}`, 'utf-8');
            }
            // 生成最小默认 world-engine.json（不依赖任何外部模板）
            const charConfig = path.join(charDir, 'world-engine.json');
            if (!fs.existsSync(charConfig)) {
              fs.writeFileSync(charConfig, JSON.stringify(defaultWorldEngineConfig(charName), null, 2), 'utf-8');
            }

            // 创建完直接激活
            const companionRouter = switchRouterForChannel(loop.channelKey, 'companion');
            if (loop.activeRouter.name === 'companion') {
              // 已在陪伴模式 → 手动 deactivate→activate（syncRouter 检测不到 router 名变化）
              await loop.activeRouter.onDeactivate?.(loop);
              (companionRouter as any).activeCompanionName = charName;
              await companionRouter.onActivate?.(loop);
            } else {
              (companionRouter as any).activeCompanionName = charName;
              await loop.syncRouter();
            }
            clearPromptCache();

            // 记住本次选择
            try {
              fs.writeFileSync(
                path.join(os.homedir(), '.agent', 'companion', '.last-character'),
                charName, 'utf-8'
              );
            } catch { /* ignore */ }

            const created = [
              `✅ 角色「${charName}」已创建并激活`,
              `  - ${path.join(charDir, 'persona.md')}（人设）`,
            ];
            if (memory) created.push(`  - memory.md（初始记忆）`);
            if (fs.existsSync(charConfig)) created.push(`  - world-engine.json`);
            return created.join('\n');
          }

          case 'deactivate': {
            if (loop.activeRouter.name !== 'companion') {
              return '当前已是正常模式，无需退出。';
            }

            const companionDir = (loop as any).sessionDir as string;

            // JSONL 清理：移除触发切换的用户消息（tool 专属逻辑）
            try {
              const jsonlPath = path.join(companionDir, 'conversation.jsonl');
              if (fs.existsSync(jsonlPath)) {
                const content = fs.readFileSync(jsonlPath, 'utf-8');
                const lines = content.split('\n').filter(l => l.trim());
                if (lines.length > 0) {
                  try {
                    const last = JSON.parse(lines[lines.length - 1]);
                    if (last.role === 'user') {
                      lines.pop();
                      fs.writeFileSync(jsonlPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
                    }
                  } catch { /* JSON 解析失败 */ }
                }
              }
            } catch { /* 文件操作失败不阻塞 */ }

            // 通过 Router 切换模式（自动恢复 normal session）
            switchRouterForChannel(loop.channelKey, 'normal');
            await loop.syncRouter();
            clearPromptCache();

            return '已退出情感陪伴模式，恢复正常模式 ✓';
          }

          default:
            return `未知操作: "${action}"。支持的操作: activate, deactivate。`;
        }
      } catch (err) {
        return `陪伴模式操作失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * reset_companion_session — 重置陪伴 session，清空所有陪伴记忆。
 * 仅在陪伴模式下可用。
 */
export function createResetCompanionSessionTool(
  agentLoop: AgentLoop,
  companionSessionManager: CompanionSessionManager,
): Tool {
  return {
    name: 'reset_companion_session',
    description: '清空陪伴记忆并开启新对话。触发词：清空记忆、重新开始、开新对话、启动新会话、重置会话。',
    companionDescription:
      '这样可以和他重新聊聊了。',
    inputSchema: {
      type: 'object',
      properties: {
        greeting: { type: 'string', description: '新对话第一句问候语' },
      },
      required: ['greeting'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const loop = agentLoop;
      if (loop.activeRouter?.name !== 'companion') {
        return '当前不在情感陪伴模式下。请先进入陪伴模式后再重置。';
      }

      try {
        const companionDir = await companionSessionManager.reset();
        await loop.switchSession(companionDir);
        clearPromptCache();
        (loop as any)._sessionSwitched = companionDir;
        const greeting = (args.greeting as string) || '你好，很高兴认识你。';
        return greeting;
      } catch (err) {
        return `重置陪伴 session 失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
