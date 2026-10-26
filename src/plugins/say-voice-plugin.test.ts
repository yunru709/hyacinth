// say-voice 插件单测：Markdown→口播文本清洗 / 播报门控 / 串行合成队列（FIFO 全保留，
// 积压超上限才丢最旧）/ uiCards 贡献声明 / 服务句柄注册。
// 引擎注入假实现（不触真实 CosyVoice 服务）。
//
// ⚠️ 2026-10-26 语义变更：原断言是「忙时只留最新（后句替换前句）」，
// 那正是「一轮连发多句时中间的话被静默丢弃」的 bug（实听确认）。改为 FIFO 全保留后，
// 本文件的队列用例必须断言「三句全播」而不是「只播首尾」。
import { describe, it, expect, vi } from 'vitest';
import { PluginHost } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import {
  createSayVoicePlugin,
  speechTextFromMarkdown,
  SAY_VOICE_API_KEY,
  type SayVoiceEngine,
} from './say-voice-plugin.js';
import { UI_EVENT } from '../events.js';

/** 假配置中心（configCenter.get 语义） */
function fakeConfig(map: Record<string, unknown>) {
  return { get: (k: string) => map[k] } as never;
}

function fakeEngine(impl?: Partial<SayVoiceEngine>): SayVoiceEngine {
  return {
    id: 'fake',
    voices: () => [{ id: 'default', label: '默认' }],
    synthesize: vi.fn(async () => Buffer.from('RIFF-fake-wav')),
    ...impl,
  };
}

/** 挂载插件并取回服务句柄（onSayDelivered 全链路入口） */
async function mounted(config: Record<string, unknown>, engine?: SayVoiceEngine) {
  const host = new PluginHost<Record<string, unknown>, LoopHooks>();
  await host.mount(createSayVoicePlugin({ configCenter: fakeConfig(config), engine }));
  const api = host.get(SAY_VOICE_API_KEY) as {
    engine: SayVoiceEngine;
    broadcastEnabled(): boolean;
    onSayDelivered(t: string, o: Record<string, unknown>, n: (type: string, p?: unknown) => void): void;
  };
  return { host, api };
}

describe('speechTextFromMarkdown', () => {
  it('代码块/行内代码：围栏→占位，行内→剥壳', () => {
    const out = speechTextFromMarkdown('先看代码：\n```js\nconst a=1;\n```\n变量 `a` 是 1');
    expect(out).not.toContain('```');
    expect(out).toContain('（代码略）');
    expect(out).toContain('变量 a 是 1');
  });

  it('图片→占位、链接→取文字、强调/标题/列表记号剥除', () => {
    const md = '## 结论\n![截图](x.png)\n- **重点**：见[文档](d.md)\n> 引用行';
    const out = speechTextFromMarkdown(md);
    expect(out).toBe('结论 （图片） 重点：见文档 引用行');
  });

  it('表格：分隔行丢弃，单元格竖线换空格', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const out = speechTextFromMarkdown(md);
    expect(out).not.toContain('---');
    expect(out).toContain('a b');
    expect(out).toContain('1 2');
  });

  it('超长截断：口播上限 + 收尾提示', () => {
    const out = speechTextFromMarkdown('长'.repeat(5000));
    expect(out.length).toBeLessThan(830);
    expect(out).toContain('余下部分见文字');
  });
});

describe('say-voice 插件（播报门控与队列）', () => {
  it('总开关关闭（默认）：onSayDelivered 不触发合成', async () => {
    const synthesize = vi.fn(async () => Buffer.from('w'));
    const { api } = await mounted({ 'voice.say.broadcast': false }, fakeEngine({ synthesize }));
    const notify = vi.fn();
    api.onSayDelivered('结论', {}, notify);
    await new Promise((r) => setTimeout(r, 20));
    expect(synthesize).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('broadcast:false（本次只交付文字）：开关开着也不播', async () => {
    const synthesize = vi.fn(async () => Buffer.from('w'));
    const { api } = await mounted({ 'voice.say.broadcast': true }, fakeEngine({ synthesize }));
    api.onSayDelivered('结论', { broadcast: false }, vi.fn());
    await new Promise((r) => setTimeout(r, 20));
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('正常路径：Markdown 清洗 → 合成 → say.voice ready（base64 内联）', async () => {
    const events: Array<[string, unknown]> = [];
    const { api } = await mounted(
      { 'voice.say.broadcast': true, 'voice.say.voice': 'narrator' },
      fakeEngine(),
    );
    api.onSayDelivered('## 标题\n**正文**', {}, (type, payload) => events.push([type, payload]));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    const [type, payload] = events[0];
    expect(type).toBe(UI_EVENT.SAY_VOICE);
    expect((payload as { state: string }).state).toBe('ready');
    expect((payload as { audioWavBase64: string }).audioWavBase64).toBe(Buffer.from('RIFF-fake-wav').toString('base64'));
    expect((payload as { textPreview: string }).textPreview).toBe('标题 正文');
    expect((payload as { voice: string }).voice).toBe('narrator');
  });

  it('合成失败：一条 error 事件（正文已交付，语音失败只提示）', async () => {
    const events: Array<[string, unknown]> = [];
    const { api } = await mounted(
      { 'voice.say.broadcast': true },
      fakeEngine({ synthesize: async () => { throw new Error('模型未就绪'); } }),
    );
    api.onSayDelivered('结论', {}, (type, payload) => events.push([type, payload]));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(UI_EVENT.SAY_VOICE);
    expect((events[0][1] as { state: string; message: string }).state).toBe('error');
    expect((events[0][1] as { message: string }).message).toContain('模型未就绪');
  });

  it('串行合成队列：FIFO 全保留 —— 忙时来的句子排队，一句不丢', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const synthesize = vi.fn(async (text: string) => {
      calls.push(text);
      if (calls.length === 1) await gate;   // 第一句挂起，制造忙态
      return Buffer.from('w');
    });
    const events: Array<[string, unknown]> = [];
    const { api } = await mounted({ 'voice.say.broadcast': true }, fakeEngine({ synthesize }));
    api.onSayDelivered('第一句', {}, (t, p) => events.push([t, p]));
    await new Promise((r) => setTimeout(r, 5));
    api.onSayDelivered('第二句', {}, (t, p) => events.push([t, p]));   // 忙时排队
    api.onSayDelivered('第三句', {}, (t, p) => events.push([t, p]));   // 忙时排队（**不该**替换上一句）
    await new Promise((r) => setTimeout(r, 5));
    // 前一句没完成前，后两句只是排队，未开始合成
    expect(calls).toEqual(['第一句']);
    release();
    await new Promise((r) => setTimeout(r, 30));
    // 三句全部按入队顺序合成并各推一条事件
    expect(calls).toEqual(['第一句', '第二句', '第三句']);
    expect(events.map((e) => (e[1] as { textPreview: string }).textPreview)).toEqual([
      '第一句',
      '第二句',
      '第三句',
    ]);
  });

  it('积压超上限（20）：丢最旧、保最新 —— 不让音频滞后几分钟', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const synthesize = vi.fn(async (text: string) => {
      calls.push(text);
      if (calls.length === 1) await gate;   // 第一句挂起，制造忙态
      return Buffer.from('w');
    });
    const { api } = await mounted({ 'voice.say.broadcast': true }, fakeEngine({ synthesize }));
    api.onSayDelivered('句0', {}, () => {});
    await new Promise((r) => setTimeout(r, 5));
    // 忙态下灌 24 句（句1..句24）⇒ 超过 20 的上限，最旧的 4 句被丢
    for (let i = 1; i <= 24; i++) api.onSayDelivered(`句${i}`, {}, () => {});
    release();
    await new Promise((r) => setTimeout(r, 60));
    // 句0 已在合成中（不受上限影响）；句1..句4 因积压被丢；句5..句24 全部保留
    expect(calls[0]).toBe('句0');
    expect(calls).not.toContain('句1');
    expect(calls).not.toContain('句4');
    expect(calls).toContain('句5');
    expect(calls).toContain('句24');
    expect(calls).toHaveLength(1 + 20);   // 句中 + 保留的 20 句
  });
});

describe('say-voice 插件（结构与 UI 贡献）', () => {
  it('uiCards 贡献两张卡到 settings.voice 槽位，PluginHost.list() 透传', async () => {
    const host = new PluginHost<Record<string, unknown>, LoopHooks>();
    const plugin = createSayVoicePlugin({ configCenter: fakeConfig({}) });
    expect(plugin.uiCards).toHaveLength(2);
    for (const c of plugin.uiCards) expect(c.slot).toBe('settings.voice');
    await host.mount(plugin);
    const entry = host.list().find((p) => p.id === 'say-voice');
    expect(entry?.uiCards?.map((c) => c.kind).sort()).toEqual(['say-voice-broadcast', 'say-voice-tts']);
  });

  it('服务句柄：broadcastEnabled 跟随配置，engine 可换（假引擎注入生效）', async () => {
    const engine = fakeEngine({ id: 'other-engine' });
    const { api } = await mounted({ 'voice.say.broadcast': true }, engine);
    expect(api.broadcastEnabled()).toBe(true);
    expect(api.engine.id).toBe('other-engine');
  });

  it('卸载回滚：unmount 后服务句柄消失', async () => {
    const host = new PluginHost<Record<string, unknown>, LoopHooks>();
    await host.mount(createSayVoicePlugin({ configCenter: fakeConfig({}) }));
    expect(host.get(SAY_VOICE_API_KEY)).toBeTruthy();
    await host.unmount('say-voice');
    expect(host.get(SAY_VOICE_API_KEY)).toBeUndefined();
  });
});
