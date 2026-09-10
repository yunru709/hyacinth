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

  it('index_only source renders as index entry (name + description only)', async () => {
    const composer = new LayeredContextComposer(200000);

    // zone1 的 runtime:skills section 只渲染 skill- 前缀的 manifest source
    const source: ContextSource = {
      name: 'skill-index-source',
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

    // The index_only source should appear as "- skill-index-source: Index only source"
    // not as the full content. 注意：项目 manifest 里 zone2 skills section 是 system role，
    // 所以不限定消息 role，在全部消息里找索引条目。
    const allMessages = result.messages.filter(m => typeof m.content === 'object');

    // Find the message that contains the index entry
    const indexMessage = allMessages.find(m => {
      const content = m.content;
      if (Array.isArray(content)) {
        return content.some(c => c.type === 'text' && c.text.includes('skill-index-source'));
      }
      if (content && typeof content === 'object' && 'type' in content && content.type === 'text') {
        return content.text.includes('skill-index-source');
      }
      return false;
    });

    expect(indexMessage).toBeDefined();
    // Verify it contains the index format, not the full content
    const text = extractText(indexMessage!);
    expect(text).toContain('skill-index-source');
    expect(text).toContain('Index only source');
    expect(text).not.toContain('full content that should not appear');
  });

  it('lazy_expand source expands when selected', async () => {
    const composer = new LayeredContextComposer(200000);

    const source: ContextSource = {
      name: 'skill-lazy-source',
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
      // 选中该 skill → lazy_expand 展开全文
      selectedSkills: ['lazy-source'],
    });

    // With source selected, full content should appear
    const allText = result.messages
      .map(m => extractText(m))
      .filter(Boolean)
      .join('\n');

    expect(allText).toContain('expanded content');
  });

  it('lazy_expand source shows index when not selected', async () => {
    const composer = new LayeredContextComposer(200000);

    const source: ContextSource = {
      name: 'skill-lazy-source',
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

    // Not selected → show index entry, not full content
    const allText = result.messages
      .map(m => extractText(m))
      .filter(Boolean)
      .join('\n');

    expect(allText).toContain('skill-lazy-source');
    expect(allText).toContain('Lazy expand source');
    // The full content should NOT appear when not selected
    expect(allText).not.toContain('expanded content');
  });
});

// ─── LayeredContextComposer.previewZone ─────────────────────────────────

describe('LayeredContextComposer.previewZone', () => {
  const baseOpts = {
    cwd: process.cwd(),
    sessionDir: '',
    timestamp: '2026-08-29T00:00:00.000Z',
    maxContextTokens: 200000,
    tools: [],
    history: [],
    userInput: '',
  };

  it('zone1 预览返回非空真实文本；不存在的 zone 返回 null', async () => {
    const composer = new LayeredContextComposer(200000);
    const result = await composer.previewZone('zone1', baseOpts);
    expect(result).not.toBeNull();
    expect(result!.zone).toBe('zone1');
    expect(result!.text.length).toBeGreaterThan(0);
    expect(result!.tokens).toBeGreaterThanOrEqual(0);

    // 不存在的 zone → null
    const missing = await composer.previewZone('zone_does_not_exist', baseOpts);
    expect(missing).toBeNull();
  });

  it('已注册 ContextSource 的内容出现在预览中（与线上组装一致）', async () => {
    const composer = new LayeredContextComposer(200000);
    // zone1 的 runtime:env 段按 'env-info' 名称查 source
    composer.registerSource({
      name: 'env-info',
      strategy: 'always_inline',
      cacheability: 'anchor',
      getContent: async () => 'FAKE_ENV_PREVIEW_MARKER',
    });
    const result = await composer.previewZone('zone1', baseOpts);
    expect(result).not.toBeNull();
    expect(result!.text).toContain('FAKE_ENV_PREVIEW_MARKER');
  });

  it('preview 后不影响后续正常 compose（promptBuilder 状态已还原）', async () => {
    const composer = new LayeredContextComposer(200000);
    await composer.previewZone('zone1', baseOpts);
    // 正常 compose（legacy 路径）仍可用，且不包含 zone1 泄漏 section 的报错
    const messages = await composer.compose({
      systemPrompt: 'LEGACY_SYS',
      tools: [],
      history: [],
      userInput: 'hi',
      maxContextTokens: 200000,
    });
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(1);
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
