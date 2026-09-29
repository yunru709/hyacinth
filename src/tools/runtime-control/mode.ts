// ============================================================
// switch_mode —— 模式切换的**通用入口**（不是陪伴专有）
// ============================================================
//
// 为什么要有它：模式此前**没有通用入口** —— 想进一个模式，得靠那个模式自己长一把
// 工具（陪伴就是这样），于是每个新模式都要把切换逻辑重写一遍 ✗。
//
// 本工具与"模式是什么"解耦：
//   list  —— 列出**已注册**的模式（谁注册了谁就出现；新模式自动被列出）
//   enter —— 走统一编排 `switchToMode`（未注册的名字会报错并列出可用模式）
//   exit  —— `null` = 回默认模式（默认是哪个由 mode-switch 判定，本工具不替它决定）
//
// 可见范围：**所有模式**（含普通模式）—— 否则新模式会"进得去、出不来" ✗。
// 模式专有的料（角色枚举 · 世界引擎默认配置 · 重置会话…）不由本工具承担，
// 仍留在各自模式自己的工具与注册里。
// ============================================================

import type { Tool } from '../interface.js';
import type { AgentLoop } from '../../orchestrator/loop.js';
import { clearPromptCache } from '../../prompts/loader.js';
import { switchToMode } from '../../context/mode-switch.js';
import { getRouterByName, listRouterNames } from '../../context/profiles.js';

/** 取模式的一句话描述（声明式模式自带；手写 Router 未声明时为空） */
function describe(name: string): string {
  const desc = (getRouterByName(name) as { description?: string } | undefined)?.description;
  return desc ? `：${desc}` : '';
}

export function createSwitchModeTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'switch_mode',
    description:
      '切换上下文模式（通用入口）：列出可用模式 / 进入指定模式 / 退出到默认模式。' +
      '注意 enter 切的是**上下文模式本身**；想要该模式**自己的会话**（隔离上下文、重启后仍在），' +
      '用 new_session { type: "模式名" }。' +
      '触发词：切换模式、换模式、进入X模式、退出模式、现在是什么模式、有哪些模式。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'enter', 'exit'],
          description: 'list=列出可用模式；enter=进入指定模式；exit=回到默认模式',
        },
        mode: { type: 'string', description: 'enter 用：模式名（见 action=list 的结果）' },
        params: {
          type: 'object',
          description: 'enter 用（可选）：写到该模式 Router 上的参数，如陪伴的角色名 { activeCompanionName: "柔柔" }',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = typeof args.action === 'string' ? args.action : '';
      const current = agentLoop.activeRouter?.name ?? '(未知)';

      switch (action) {
        case 'list': {
          const names = listRouterNames();
          if (names.length === 0) return '当前没有已注册的模式。';
          const lines = names.map((n) => `  - ${n}${describe(n)}${n === current ? '  ← 当前' : ''}`);
          return `可用模式（${names.length} 个；当前：${current}）\n${lines.join('\n')}`;
        }

        case 'enter': {
          const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
          if (!mode) return 'enter 需要 mode 参数。可用模式见：switch_mode { action: "list" }';
          const params =
            args.params && typeof args.params === 'object'
              ? (args.params as Record<string, unknown>)
              : undefined;
          try {
            await switchToMode(agentLoop, mode, params);
          } catch (err) {
            return `切换失败：${err instanceof Error ? err.message : String(err)}`;
          }
          clearPromptCache(); // 模式变了 ⇒ persona / section 全变，缓存必须弃掉
          return `已进入「${mode}」模式 ✓（当前：${agentLoop.activeRouter?.name ?? '(未知)'}）`;
        }

        case 'exit': {
          try {
            await switchToMode(agentLoop, null);
          } catch (err) {
            return `退出失败：${err instanceof Error ? err.message : String(err)}`;
          }
          clearPromptCache();
          return `已退出「${current}」模式，回到默认模式 ✓（当前：${agentLoop.activeRouter?.name ?? '(未知)'}）`;
        }

        default:
          return `未知操作："${action}"。支持：list、enter、exit。`;
      }
    },
  };
}
