// say 工具单测：提交成功 / 空内容 / 提交方拒绝 / is_error 语义 / sideEffect
import { describe, it, expect, vi } from 'vitest';
import { createSayTool } from './say.js';

describe('say 工具', () => {
  it('正常提交：content 透传给 submit，返回确认文本', async () => {
    const submit = vi.fn().mockReturnValue({ ok: true });
    const tool = createSayTool(submit);

    const out = await tool.execute({ content: '任务已完成，产出如下…' });

    expect(submit).toHaveBeenCalledWith('任务已完成，产出如下…');
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

    expect(submit).toHaveBeenCalledWith('');
  });

  it('只读副作用：不触发权限审批（sideEffect=read）', () => {
    const tool = createSayTool(() => ({ ok: true }));

    expect(tool.sideEffect).toBe('read');
    expect(tool.name).toBe('say');
    expect(tool.inputSchema.required).toEqual(['content']);
  });
});
