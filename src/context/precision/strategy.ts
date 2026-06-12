import type { Message } from '../../types.js';
import type { Provider } from '../../provider/interface.js';
import type { ComposeStrategy, ComposeStrategyOptions } from './types.js';
import { KeywordPool } from './keyword-pool.js';
import { SummaryStore } from './summary-store.js';
import { analyzeConversation, matchHistory } from './analyzer.js';

export class PreciseStrategy implements ComposeStrategy {
  name = 'precise';
  private pool: KeywordPool;
  private summaries: SummaryStore;
  private recentCount = 3;
  private keywordMatchThreshold = 2;

  constructor(sessionDir: string, options?: { keywordMatchThreshold?: number; recentCount?: number }) {
    this.pool = new KeywordPool(sessionDir);
    this.summaries = new SummaryStore(sessionDir);
    if (options?.keywordMatchThreshold !== undefined) this.keywordMatchThreshold = options.keywordMatchThreshold;
    if (options?.recentCount !== undefined) this.recentCount = options.recentCount;
  }

  prepareCompose(_personaDir: string | undefined): ComposeStrategyOptions {
    return { personaDir: undefined, preciseMode: true };
  }

  filterHistory(history: Message[]): Message[] {
    const keywords = this.pool.getTop(20);
    const allSummaries = this.summaries.getAll();
    if (keywords.length === 0 && allSummaries.length === 0) {
      return history.slice(-(this.recentCount * 2));
    }
    const recent = history.slice(-(this.recentCount * 2));
    const older = history.slice(0, -(this.recentCount * 2));
    const matched = matchHistory(older, keywords, allSummaries, this.keywordMatchThreshold);
    const maxMatched = 20;
    const trimmed = matched.length > maxMatched ? matched.slice(-maxMatched) : matched;
    return [...trimmed, ...recent];
  }

  async analyzeTurn(messages: Message[], provider: Provider): Promise<void> {
    try {
      const result = await analyzeConversation(messages, provider);
      if (result.keywords.length > 0) {
        this.pool.addAll(result.keywords);
        this.pool.prune(200);
        this.pool.save();
      }
      if (result.turns.length > 0) {
        this.summaries.merge(result.turns);
      }
    } catch {
      // 异步分析失败不影响主流程
    }
  }
}
