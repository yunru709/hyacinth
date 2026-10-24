// say 工具单测：提交成功 / 空内容 / 提交方拒绝 / is_error 语义 / sideEffect / 语音参数
import { describe, it, expect, vi } from 'vitest';
import { createSayTool, parseSayVoiceOptions } from './say.js';

describe('say 工具', () => {
  it('正常提交：content 透传给 submit，返回确认文本', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    const tool = createSayTool(submit);

    const out = await tool.execute({ content: '任务已完成，产出如下…' });

    expect(submit).toHaveBeenCalledWith('任务已完成，产出如下…', {});
    expect(out).toBe('ok');
  });

  it('提交方拒绝（ok:false）→ 抛错（框架落 is_error → loop 自动续轮重试）', async () => {
    const submit = vi.fn().mockReturnValue({ ok: false, error: 'content 不能为空' });
    const tool = createSayTool(submit);

    await expect(tool.execute({ content: '' })).rejects.toThrow('content 不能为空');
  });

  it('支持异步 submit', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const tool = createSayTool(submit);

    await expect(tool.execute({ content: 'x' })).resolves.toBe('ok');
  });

  it('缺省 content 视为空串（交给 submit 校验，工具自身不判空）', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    const tool = createSayTool(submit);

    await tool.execute({});

    expect(submit).toHaveBeenCalledWith('', {});
  });

  it('语音侧提示：voiceNotice 返回文案时 ok 附带明示（交付不受影响）', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    const tool = createSayTool(submit, (opts) =>
      opts.broadcast === false ? null : '未执行 —— TTS 模型未就绪，请在 设置 → 语音 下载模型');
    const out = await tool.execute({ content: '结论' });
    expect(out).toBe('ok（语音播报：未执行 —— TTS 模型未就绪，请在 设置 → 语音 下载模型）');
    // broadcast:false（本次不朗读）→ 无提示，返回裸 ok
    const out2 = await tool.execute({ content: '结论', broadcast: false });
    expect(out2).toBe('ok');
  });

  it('voiceNotice 缺省（未注入）：返回值保持裸 ok（零开销路径）', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    const out = await createSayTool(submit).execute({ content: 'x' });
    expect(out).toBe('ok');
  });

  it('只读副作用：不触发权限审批（sideEffect=read）', () => {
    const tool = createSayTool(() => ({ ok: true }));

    expect(tool.sideEffect).toBe('read');
    expect(tool.name).toBe('say');
    expect(tool.inputSchema.required).toEqual(['content']);
  });

  // ── 语音参数（2026-10-24 say-voice 插件接入）──────────────────────

  it('语音参数透传：voice/speed/emotion/broadcast 原样进 submit 第二参', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    const tool = createSayTool(submit);

    await tool.execute({ content: '结论', voice: 'narrator', speed: 1.5, emotion: 'warm', broadcast: false });

    expect(submit).toHaveBeenCalledWith('结论', {
      voice: 'narrator',
      speed: 1.5,
      emotion: 'warm',
      broadcast: false,
    });
  });

  it('未带语音参数：submit 第二参为空选项对象（插件未装配时零开销）', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    await createSayTool(submit).execute({ content: '纯文字交付' });
    expect(submit).toHaveBeenCalledWith('纯文字交付', {});
  });

  it('坏值语音参数静默丢弃：content 才是关键交付物，不为 voice 笔误打断交付', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    await createSayTool(submit).execute({
      content: '结论',
      voice: 123, speed: '快', emotion: null, broadcast: 'no',
    });
    expect(submit).toHaveBeenCalledWith('结论', {});
  });
});

describe('parseSayVoiceOptions', () => {
  it('speed 收敛到 [0.5, 2]：超界夹回边界而非报错', () => {
    expect(parseSayVoiceOptions({ speed: 10 }).speed).toBe(2);
    expect(parseSayVoiceOptions({ speed: 0.1 }).speed).toBe(0.5);
    expect(parseSayVoiceOptions({ speed: 1.25 }).speed).toBe(1.25);
  });

  it('broadcast 只认显式 false（true/其它值都不写入 —— 默认跟随用户设置）', () => {
    expect(parseSayVoiceOptions({ broadcast: false }).broadcast).toBe(false);
    expect(parseSayVoiceOptions({ broadcast: true }).broadcast).toBeUndefined();
    expect(parseSayVoiceOptions({}).broadcast).toBeUndefined();
  });

  it('空串/纯空白字符串参数丢弃', () => {
    expect(parseSayVoiceOptions({ voice: '  ', emotion: '' })).toEqual({});
  });
});

