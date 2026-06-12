import type { Message } from '../../types.js';
import type { Provider } from '../../provider/interface.js';
import type { ComposeStrategy, ComposeStrategyOptions } from './types.js';

/**
 * DefaultStrategy — 普通模式。
 * 所有方法均为透传，零性能损耗。
 */
export class DefaultStrategy implements ComposeStrategy {
  name = 'default';

  prepareCompose(personaDir: string | undefined): ComposeStrategyOptions {
    return { personaDir, preciseMode: false };
  }

  filterHistory(history: Message[]): Message[] {
    return history;
  }

  async analyzeTurn(_messages: Message[], _provider: Provider): Promise<void> {
    // 不做事
  }
}
