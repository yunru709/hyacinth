// companion 表达链路单测：normalizeForTts + companion_say 工具
import { describe, it, expect } from 'vitest';
import { normalizeForTts } from './normalize.js';
import { createCompanionSayTool } from '../tools/companion-say.js';
import { CompanionVoiceService } from './voice.js';
import type { AgentLoop } from '../orchestrator/loop.js';

describe('normalizeForTts', () => {
  it('剥离 markdown 符号/代码块/链接/URL', () => {
    const out = normalizeForTts('## 标题\n**重点**内容和`code`参见 https://x.com/a 以及[文档](https://y.cn)。');
    expect(out).not.toMatch(/##|\*\*|`|https?:/);
    expect(out).toContain('重点');
    expect(out).toContain('文档');
  });

  it('剥离括号动作与 emoji', () => {
    const out = normalizeForTts('（微笑）你回来啦 😊~ 累不累？');
    expect(out).toBe('你回来啦 ~ 累不累？');
  });

  it('超长截断并加省略号', () => {
    const out = normalizeForTts('啊'.repeat(600));
    expect(out.length).toBe(502); // 500 + 省略号 2 字符
    expect(out.endsWith('……')).toBe(true);
  });

  it('空输入返回空串', () => {
    expect(normalizeForTts('')).toBe('');
  });
});

describe('CompanionVoiceService 语音缓存（生成语音库：角色-文本-情绪-音色 去重）', () => {
  it('同角色+同音色+同台词：第二次直接复用生成语音库音频，不再调 TTS；换音色/情绪不复用', async () => {
    let generateCalls = 0;
    const notifications: Array<{ state?: string; url?: string; cached?: boolean }> = [];
    const registry = { getDefaultProviderName: () => 'prov' };
    const service = {
      generate: async () => {
        generateCalls += 1;
        return { localPath: '/tmp/x.wav', sourceUrl: 'x', mediaType: 'audio/wav', byteSize: 1, provider: 'prov', model: 'm', createdAt: 't' };
      },
    };
    // fake 生成语音库：内存版（唯一键 character|textHash|emotionKey|voiceId）
    const rows: Array<{ id: string; character: string; textHash: string; emotionKey: string; voiceId: string; url: string }> = [];
    const store = {
      find: (character: string, textHash: string, emotionKey: string, voiceId: string) =>
        rows.find((r) => r.character === character && r.textHash === textHash && r.emotionKey === emotionKey && r.voiceId === voiceId),
      insert: (src: string, e: { character: string; textHash: string; emotionKey?: string; voiceId?: string; format: string }) => {
        const row = {
          id: 'gv_' + (rows.length + 1),
          character: e.character,
          textHash: e.textHash,
          emotionKey: e.emotionKey ?? '',
          voiceId: e.voiceId ?? '',
          url: '/api/companion/voice/gv_' + (rows.length + 1) + '/file',
        };
        rows.push(row);
        return row;
      },
    };
    const voice = new CompanionVoiceService({
      registry: registry as never,
      service: service as never,
      store: store as never,
      cwd: '/tmp',
    });
    const notify = (type: string, payload?: unknown) => {
      notifications.push(payload as { state?: string; url?: string; cached?: boolean });
    };
    const cfg = { enabled: true };

    voice.onTurnEnd('你好呀', '小蝶', notify, cfg, { voice: 'xiaodie', voiceId: 'xiaodie' });
    await new Promise((r) => setTimeout(r, 20));
    voice.onTurnEnd('你好呀', '小蝶', notify, cfg, { voice: 'xiaodie', voiceId: 'xiaodie' });
    await new Promise((r) => setTimeout(r, 20));

    expect(generateCalls).toBe(1); // 第二次命中生成语音库，不烧 TTS
    expect(rows).toHaveLength(1);
    const ready = notifications.filter((n) => n.state === 'ready');
    expect(ready).toHaveLength(2);
    expect(ready[1]!.cached).toBe(true);
    expect(ready[1]!.url).toBe('/api/companion/voice/gv_1/file');

    // 换情绪 → 不同索引条目 → 重新合成
    voice.onTurnEnd('你好呀', '小蝶', notify, cfg, { voice: 'xiaodie', voiceId: 'xiaodie', tone: '生气' });
    await new Promise((r) => setTimeout(r, 20));
    expect(generateCalls).toBe(2);
    expect(rows).toHaveLength(2);
  });
});

/** fake loop：捕获事件/表达/语音调用 */
function makeFakeLoop() {
  const events: Array<{ type: string; payload?: unknown }> = [];
  const expressions: Array<{ text: string; as: string; tone?: string }> = [];
  const voiceCalls: Array<{ text: string; character: string; overrides?: { voice?: string; voiceId?: string; tone?: string; sayId?: string } }> = [];
  const loop = {
    outputHandler: null,
    activeRouter: { name: 'companion', activeCompanionName: '小蝶' },
    companionExpressions: expressions,
    recordCompanionExpression(e: { text: string; as: string; tone?: string }) {
      expressions.push(e);
    },
    emitUiEvent(type: string, payload?: unknown) {
      events.push({ type, payload });
    },
    companionVoice: {
      onTurnEnd(text: string, character: string, _notify: unknown, overrides?: { voice?: string; tone?: string }) {
        voiceCalls.push({ text, character, overrides });
      },
    },
  } as unknown as AgentLoop;
  return { loop, events, expressions, voiceCalls };
}

describe('companion_say 工具', () => {
  it('完整表达：渲染 [动作]（心声）内容 + 捕获 + TTS 只朗读内容', async () => {
    const { loop, events, expressions, voiceCalls } = makeFakeLoop();
    const tool = createCompanionSayTool(loop);

    const result = await tool.execute({
      text: '回来啦？今天过得怎么样？',
      tone: '惊喜',
      think: '终于等到他了',
      action: '放下书抬头',
    });

    expect(result).toContain('已表达');
    const say = events.find((e) => e.type === 'companion.say');
    expect((say!.payload as { text: string }).text).toBe('[放下书抬头]（终于等到他了）回来啦？今天过得怎么样？');
    expect(expressions).toEqual([{ text: '回来啦？今天过得怎么样？', as: 'speak', tone: '惊喜' }]);
    // TTS 只朗读内容（动作/心声不朗读），语气透传，且每次表达带唯一 sayId
    expect(voiceCalls).toHaveLength(1);
    expect(voiceCalls[0]!.text).toBe('回来啦？今天过得怎么样？');
    expect(voiceCalls[0]!.character).toBe('小蝶');
    expect(voiceCalls[0]!.overrides).toMatchObject({ tone: '惊喜' });
    expect(voiceCalls[0]!.overrides?.sayId).toBeTruthy();
  });

  it('只有动作与心声（无 text）：只渲染不合成', async () => {
    const { loop, events, voiceCalls } = makeFakeLoop();
    const tool = createCompanionSayTool(loop);

    const result = await tool.execute({ think: '他好像很累。', action: '安静地看着' });

    expect(result).toContain('已表达');
    expect(events.some((e) => e.type === 'companion.say')).toBe(true);
    expect(voiceCalls).toHaveLength(0);
  });

  it('普通模式下拒绝执行（陪伴专属硬隔离）', async () => {
    const { loop, events, voiceCalls } = makeFakeLoop();
    (loop.activeRouter as { name: string }).name = 'normal';
    const tool = createCompanionSayTool(loop);

    const result = await tool.execute({ text: '你好' });

    expect(result).toContain('仅在陪伴模式可用');
    expect(events).toHaveLength(0);
    expect(voiceCalls).toHaveLength(0);
  });

  it('空 text 返回错误', async () => {
    const tool = createCompanionSayTool(makeFakeLoop().loop);
    const result = await tool.execute({ text: '  ' });
    expect(result).toContain('error');
    expect(result).toContain('表达内容不能为空');
  });
});
