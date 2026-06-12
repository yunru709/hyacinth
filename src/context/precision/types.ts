import type { Message, MessageContent } from '../../types.js';
import type { Provider } from '../../provider/interface.js';

export interface ComposeStrategyOptions {
  /** 替换 persona 路径（精确模式设为 undefined 以触发 conditional 加载替代提示词） */
  personaDir?: string;
  /** 精确模式标记（manifest conditional 检测此标记） */
  preciseMode?: boolean;
}

export interface ComposeStrategy {
  name: string;

  /** 预处理 compose 选项（调用时机：compose 之前） */
  prepareCompose(personaDir: string | undefined): ComposeStrategyOptions;

  /** 过滤历史消息（调用时机：Zone 3 组装之前） */
  filterHistory(history: Message[]): Message[];

  /** 异步后处理（调用时机：LLM 回复之后） */
  analyzeTurn(messages: Message[], provider: Provider): Promise<void>;
}

export interface KeywordEntry {
  keyword: string;
  weight: number;
  source: string; // 'user' | 'assistant' | 'tool'
}
