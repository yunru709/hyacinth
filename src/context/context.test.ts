import { ToolOutputTrimmer } from './compressor.js';
import { LayeredContextComposer } from './composer.js';
import type { ContextSource } from './interface.js';
import type { Message, ToolResultContent, ToolUseContent } from '../types.js';

// ─── ToolOutputTrimmer ─────────────────────────────────────────────────

describe('ToolOutputTrimmer', () => {
  const trimmer = new ToolOutputTrimmer(6); // trimWindow = 6

  it('trims long tool output outside the recent window', () => {
    // Create 8 messages; the first 2 are outside the trimWindow of 6
    const messages: Message[] = [];

    // Message 0: user with tool_result (outside window, should be trimmed)
    messages.push({
      role: 'user',
      content: {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'This is a very long tool output that should be trimmed because it is outside the recent window of messages.',
      },
    });

    // Message 1: assistant (outside window)
    messages.push({
      role: 'assistant',
      content: { type: 'text', text: 'Response 1' },
    });

    // Messages 2-7: fill the recent window
    for (let i = 2; i < 8; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: { type: 'text', text: `Message ${i}` },
      });
    }

    const result = trimmer.trimToolResults(messages);

    // Message 0 should have been trimmed (it's a user message with tool_result outside the window)
    const firstContent = result[0].content as ToolResultContent;
    expect(firstContent.type).toBe('tool_result');
    expect(firstContent.content).not.toBe('This is a very long tool output that should be trimmed because it is outside the recent window of messages.');
    // Should contain a summary marker
    expect(firstContent.content).toMatch(/\[.*\]/);
  });

  it('does not trim tool results within the recent window', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: 'tool_1',
          content: 'Recent tool output',
        },
      },
    ];

    // With trimWindow=6, this single message is within the window
    const result = trimmer.trimToolResults(messages);
    const content = result[0].content as ToolResultContent;
    expect(content.content).toBe('Recent tool output');
  });

  it('deduplicates repeated tool results', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: 'tool_1',
          content: 'Same output',
        },
      },
      {
        role: 'user',
        content: {
          type: 'tool_result',
          tool_use_id: 'tool_2',
          content: 'Same output', // identical content, different tool_use_id
        },
      },
    ];

    const result = trimmer.deduplicateToolResults(messages);

    // The first occurrence should be replaced with a duplicate reference
    const firstContent = result[0].content as ToolResultContent;
    expect(firstContent.content).toContain('[Duplicate]');

    // The second (latest) occurrence should remain unchanged
    const secondContent = result[1].content as ToolResultContent;
    expect(secondContent.content).toBe('Same output');
  });

  it('truncateLargeToolCalls truncates oversized tool inputs', () => {
    // Create a long input string that exceeds maxJsonLength
    const longValue = 'x'.repeat(300);
    const messages: Message[] = [
      {
        role: 'assistant',
        content: {
          type: 'tool_use',
          id: 'tu_1',
          name: 'write',
          input: { file_path: '/test/file.txt', content: longValue },
        },
      },
    ];

    const result = trimmer.truncateLargeToolCalls(messages, 100);
    const content = result[0].content as ToolUseContent;
    expect(content.input).toHaveProperty('_summarized', true);
  });

  it('does not truncate tool calls within size limit', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: {
          type: 'tool_use',
          id: 'tu_1',
          name: 'read',
          input: { file_path: '/test/file.txt' },
        },
      },
    ];

    const result = trimmer.truncateLargeToolCalls(messages, 2000);
    const content = result[0].content as ToolUseContent;
    expect(content.input).not.toHaveProperty('_summarized');
  });
});

// ─── LayeredContextComposer ────────────────────────────────────────────

describe('LayeredContextComposer', () => {
  it('registerSource() stores sources and getSource() retrieves them', () => {
    const composer = new LayeredContextComposer(200000);

    const source: ContextSource = {
      name: 'test-source',
      strategy: 'always_inline',
      cacheability: 'manifest',
      description: 'A test source',
      getContent: async () => 'test content',
    };

    composer.registerSource(source);
    expect(composer.getSource('test-source')).toBe(source);
    expect(composer.getSource('nonexistent')).toBeUndefined();
  });

  it('assembleZone2() with index_only strategy includes only name and description', async () => {
    const composer = new LayeredContextComposer(200000);

    const source: ContextSource = {
      name: 'index-source',
      strategy: 'index_only',
      cacheability: 'manifest',
      description: 'Index only source',
      getContent: async () => 'full content that should not appear',
    };

    composer.registerSource(source);

    const result = await composer.compose({
      sessionDir: '/tmp/test',
      
      maxContextTokens: 200000,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      tools: [],
      history: [],
      userInput: 'test',
    });

    // The index_only source should appear as "- index-source: Index only source"
    // not as the full content
    const userMessages = result.messages.filter(
      m => m.role === 'user' && typeof m.content === 'object',
    );

    // Find the message that contains the index entry
    const indexMessage = userMessages.find(m => {
      const content = m.content;
      if (Array.isArray(content)) {
        return content.some(c => c.type === 'text' && c.text.includes('index-source'));
      }
      if (content && typeof content === 'object' && 'type' in content && content.type === 'text') {
        return content.text.includes('index-source');
      }
      return false;
    });

    expect(indexMessage).toBeDefined();
    // Verify it contains the index format, not the full content
    const text = extractText(indexMessage!);
    expect(text).toContain('index-source');
    expect(text).toContain('Index only source');
    expect(text).not.toContain('full content that should not appear');
  });

  it('assembleZone2() with lazy_expand strategy expands in precise mode', async () => {
    const composer = new LayeredContextComposer(200000);

    const source: ContextSource = {
      name: 'lazy-source',
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: 'Lazy expand source',
      getContent: async () => 'expanded content',
    };

    composer.registerSource(source);

    const result = await composer.compose({
      sessionDir: '/tmp/test',
      
      maxContextTokens: 200000,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      tools: [],
      history: [],
      userInput: 'test',
    });

    // With source selected, full content should appear
    const allText = result.messages
      .map(m => extractText(m))
      .filter(Boolean)
      .join('\n');

    expect(allText).toContain('expanded content');
  });

  it('assembleZone2() with lazy_expand strategy shows index in normal mode', async () => {
    const composer = new LayeredContextComposer(200000);

    const source: ContextSource = {
      name: 'lazy-source',
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: 'Lazy expand source',
      getContent: async () => 'expanded content',
    };

    composer.registerSource(source);

    const result = await composer.compose({
      sessionDir: '/tmp/test',
      
      maxContextTokens: 200000,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      tools: [],
      history: [],
      userInput: 'test',
    });

    // In normal mode, should show index entry, not full content
    const allText = result.messages
      .map(m => extractText(m))
      .filter(Boolean)
      .join('\n');

    expect(allText).toContain('lazy-source');
    expect(allText).toContain('Lazy expand source');
    // The full content should NOT appear in normal mode
    expect(allText).not.toContain('expanded content');
  });
});

// ─── Helper ────────────────────────────────────────────────────────────

function extractText(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => (c as { type: 'text'; text: string }).text)
      .join('\n');
  }
  if (content.type === 'text') {
    return (content as { type: 'text'; text: string }).text;
  }
  return '';
}
