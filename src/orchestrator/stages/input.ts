/**
 * P1 状态收敛 · M3 —— input 阶段模块（槽位 `input`，模块 id `builtin:input-normalize`）。
 *
 * 职责（P1-状态收敛方案.md §三）：历史读入、userInput 提取/归一化、续轮判定。
 * 从 runTurn 开头摘出（原 loop.ts ~1655-1749），保持行为零变更：
 * - 纯计算 + 一次 store 读入，无副作用；ephemeralInput 消费由调用方按返回值处置
 * - contextDirty 应用（配置热更新）与 needsCompression 警告属 input 段的副作用，
 *   暂留在 runTurn（M4 context 阶段化时一并处理）
 *
 * 依赖注入走 StageContext.get/require（内核服务注册表，M7 升级为统一服务注册）：
 * - 'conversationStore' → ConversationStore
 * - 'sessionDir'        → string（调用方每轮刷新）
 */

import type { Message } from '../../types.js';
import { materializeExpressions } from '../../context/companion-filter.js';
import { extractTextContent, hasTextContent, hasToolUseContent, isSameTextMessage } from '../../utils/misc.js';
import type { StageModule } from '../../kernel/pipeline.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState } from '../turn-state.js';

export const INPUT_STAGE_ID = 'builtin:input-normalize';

export function createInputStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: INPUT_STAGE_ID,
    name: 'input-normalize',
    version: '1.0.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: ['history', 'userInput', 'ephemeralInput', 'companionMode'],
    writes: ['history', 'userInput', 'hasPendingToolCalls', 'historyWithoutLastUser', 'lastUserTextMsg', 'uncompressedMsgs', 'ephemeralInput'],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      // 历史读入（本轮从会话存储拉取原始历史）
      const store = ctx.require('conversationStore');
      const sessionDir = ctx.require('sessionDir');
      const raw = await store.readAll(sessionDir);

      // 获取最后一条 user 消息作为 userInput
      // 排除纯 tool_result 的 user 消息（避免误删工具结果）
      const lastUserTextMsg = [...raw].reverse().find(
        (m) => m.role === 'user' && hasTextContent(m.content),
      );
      let userInputText = lastUserTextMsg
        ? extractTextContent(lastUserTextMsg.content)
        : '';

      // 陪伴模式纯旁白轮：本轮 input 来自旁路 LLM 的瞬态产出（未落盘、不在 history 中）
      const ephemeralInput = state.ephemeralInput;

      // 判断是否是工具执行后的续轮（history 中有 tool_use）
      const hasPendingToolCalls = raw.some(
        (m) => m.role === 'assistant' && hasToolUseContent(m.content),
      );

      // 陪伴模式：表达先文本化再进压缩（压缩器/摘要看到自然文本，
      // 台词不因「工具输出」被摘要丢弃导致失忆；普通模式维持原样）
      const uncompressedMsgs = state.companionMode ? materializeExpressions(raw) : raw;

      // 从 history 中排除最后一条 user 文本消息（compose 会重新添加）
      // 工具执行续轮时保留在历史中供上下文参考，但不清除 userInput 以避免重复注入
      // 瞬态旁白轮：当前 input 不在 history 中，不剥离任何历史 user 消息
      const historyWithoutLastUser = hasPendingToolCalls || ephemeralInput
        ? raw
        : lastUserTextMsg
          ? raw.filter((m) => !isSameTextMessage(m, lastUserTextMsg))
          : raw;

      // 续轮时清空 userInput，防止同一条用户消息被重新注入为"新输入"
      // 判断依据：历史最末尾不是用户新文本（而是 tool_result），说明是续轮
      // 如果末尾是用户文本消息（如新的"好了停吧"），则保留 userInput
      const lastMsg = raw[raw.length - 1];
      const hasFreshUserInput = lastMsg?.role === 'user' && hasTextContent(lastMsg.content);
      if (!hasFreshUserInput) {
        userInputText = '';
      }

      // 纯旁白轮：用旁路瞬态产出覆盖本轮 userInput，并消费一次（续轮/下一轮不再注入）
      if (ephemeralInput) {
        userInputText = ephemeralInput;
      }

      return {
        ...state,
        history: raw, // 原始历史（bypass preTurn 仍用）
        userInput: userInputText,
        hasPendingToolCalls,
        historyWithoutLastUser,
        lastUserTextMsg: lastUserTextMsg ?? null,
        uncompressedMsgs,
        ephemeralInput: null, // 已消费标记：调用方据此清空 this.activeRouter.ephemeralInput
      };
    },
  };
}

/** input 阶段服务键声明（装配方注册时对照） */
export const INPUT_STAGE_SERVICES = ['conversationStore', 'sessionDir'] as const;

export type { Message };
