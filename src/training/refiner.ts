import type { RefinedSample } from './refined-store.js';
import type { Provider } from '../provider/interface.js';
import type { ConversationTurn } from './aggregator.js';
import type { Message } from '../types.js';

export class DataRefiner {
  private static readonly REFINE_PROMPT = `You are a data refinement assistant. Given conversation turns between a user and an AI assistant, extract high-quality training samples in instruction-input-output format.

Rules:
- Each sample should capture a distinct, useful interaction
- "instruction" describes what the user wants
- "input" provides context (can be empty string if no context needed)
- "output" is the assistant's helpful response
- Skip low-quality or trivial exchanges
- Output ONLY a JSON array of objects, no other text

Format:
[{"instruction": "...", "input": "...", "output": "..."}]`;

  async refine(turns: ConversationTurn[], provider: Provider): Promise<RefinedSample[]> {
    const turnsText = turns
      .map((turn) => `Role: user\nContent: ${turn.userMessage}\nRole: assistant\nContent: ${turn.assistantReply}`)
      .join('\n\n');

    const messages: Message[] = [
      { role: 'system', content: { type: 'text', text: DataRefiner.REFINE_PROMPT } },
      { role: 'user', content: { type: 'text', text: turnsText } },
    ];

    let rawResponse: string;
    try {
      rawResponse = '';
      for await (const event of provider.createStream(messages)) {
        if (event.type === 'TEXT') {
          rawResponse += event.content;
        }
      }
    } catch {
      console.warn('[DataRefiner] Provider call failed, degrading to raw conversation data');
      return this.degradeToRawSamples(turns);
    }

    try {
      const parsed = JSON.parse(rawResponse);
      if (!Array.isArray(parsed)) {
        console.warn('[DataRefiner] LLM response is not a JSON array, degrading to raw conversation data');
        return this.degradeToRawSamples(turns);
      }
      return parsed.filter(
        (item: unknown): item is RefinedSample =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).instruction === 'string' &&
          typeof (item as Record<string, unknown>).input === 'string' &&
          typeof (item as Record<string, unknown>).output === 'string',
      );
    } catch {
      console.warn('[DataRefiner] Failed to parse LLM response as JSON, degrading to raw conversation data');
      return this.degradeToRawSamples(turns);
    }
  }

  private degradeToRawSamples(turns: ConversationTurn[]): RefinedSample[] {
    return turns.map((turn) => ({
      instruction: turn.userMessage,
      input: '',
      output: turn.assistantReply,
      metadata: { source: 'degraded', createdAt: new Date().toISOString() },
    }));
  }
}
