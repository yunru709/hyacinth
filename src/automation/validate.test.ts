/**
 * AutomationRule 静态校验测试（2026-10-30）
 *
 * 重点不是"能通过"，而是**该拒绝的必须拒绝**：
 * 模型生成的链路一旦被放行就会真的执行工具，校验漏掉一条就是一次自动化事故。
 */

import { describe, expect, it } from 'vitest';

import type { ValidationContext } from './validate.js';
import { validateRule } from './validate.js';

const ctx: ValidationContext = {
  knownProbeKinds: ['file', 'http', 'process', 'port', 'ui_region'],
  knownToolNames: ['say', 'write', 'bash', 'http_request'],
  knownHandlers: ['core.diagnostics-append', 'core.invoke-tool'],
  knownEvents: ['afterToolExecute', 'onTurnEnd', 'afterWatch', 'afterScheduleTask'],
};

/** 最小合法规则（机械：进程退出 → 说一句） */
function baseRule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    name: '微信关闭提醒',
    enabled: false,
    when: { kind: 'probe', probe: { kind: 'process', spec: { name: 'Weixin', expect: 'exit' } } },
    do: [{ sink: 'invoke', tool: 'say', args: { content: '怎么把微信关了' } }],
    ...over,
  };
}

describe('validateRule：合法链路', () => {
  it('机械链路（probe → invoke）通过', () => {
    const r = validateRule(baseRule(), ctx);
    expect(r.errors).toEqual([]);
    expect(r.rule?.do).toHaveLength(1);
    expect(r.rule?.when.kind).toBe('probe');
  });

  it('智能链路（probe → wake reuse）通过', () => {
    const r = validateRule(
      baseRule({
        do: [
          {
            sink: 'wake',
            where: { policy: 'reuse', target: { sessionId: 's1', channel: 'webui' } },
            prompt: '看看日志',
          },
        ],
      }),
      ctx,
    );
    expect(r.errors).toEqual([]);
  });

  it('new 策略不需要 target（走默认渠道）', () => {
    const r = validateRule(baseRule({ do: [{ sink: 'wake', where: { policy: 'new' } }] }), ctx);
    expect(r.errors).toEqual([]);
  });

  it('gate 嵌套 + safety 通过（物理控制形态）', () => {
    const r = validateRule(
      baseRule({
        do: [
          { sink: 'invoke', tool: 'write', args: { file_path: 'a' } },
          {
            sink: 'gate',
            assert: { path: 'result.posErr', op: '<', value: 0.5 },
            onPass: [{ sink: 'invoke', tool: 'say', args: { content: 'ok' } }],
            onFail: [
              { sink: 'safety', action: 'hold' },
              { sink: 'wake', where: { policy: 'reuse', target: { sessionId: 'robot' } } },
            ],
          },
        ],
      }),
      ctx,
    );
    expect(r.errors).toEqual([]);
  });

  it('time 与 event 两种 when 都通过', () => {
    expect(validateRule(baseRule({ when: { kind: 'time', schedule: { intervalMs: 1000 } } }), ctx).errors).toEqual([]);
    expect(validateRule(baseRule({ when: { kind: 'event', event: 'afterToolExecute:write' } }), ctx).errors).toEqual([]);
  });
});

describe('validateRule：必须拒绝的情况', () => {
  it('缺 id / name / enabled', () => {
    const r = validateRule({ when: baseRule().when, do: baseRule().do }, ctx);
    expect(r.errors.join()).toContain('"id"');
    expect(r.errors.join()).toContain('"name"');
    expect(r.errors.join()).toContain('"enabled"');
    expect(r.rule).toBeUndefined();
  });

  it('未知 probe kind', () => {
    const r = validateRule(
      baseRule({ when: { kind: 'probe', probe: { kind: 'arm-position', spec: {} } } }),
      ctx,
    );
    expect(r.errors[0]).toContain('未知的 probe kind');
  });

  it('未知工具名（防模型臆造工具）', () => {
    const r = validateRule(baseRule({ do: [{ sink: 'invoke', tool: 'arm.moveTo' }] }), ctx);
    expect(r.errors[0]).toContain('未注册');
  });

  it('未知 handler', () => {
    const r = validateRule(baseRule({ do: [{ sink: 'append', handler: 'nope' }] }), ctx);
    expect(r.errors[0]).toContain('未注册');
  });

  it('未知事件名', () => {
    const r = validateRule(baseRule({ when: { kind: 'event', event: 'onMoonPhase' } }), ctx);
    expect(r.errors[0]).toContain('未知的事件');
  });

  it('wake + reuse 但没有 target（无法确定续哪个会话）', () => {
    const r = validateRule(baseRule({ do: [{ sink: 'wake', where: { policy: 'reuse' } }] }), ctx);
    expect(r.errors[0]).toContain('必须提供 target.sessionId 或 target.channel');
  });

  it('gate 没给任何分支', () => {
    const r = validateRule(
      baseRule({ do: [{ sink: 'gate', assert: { path: 'event.x', op: '==', value: 1 } }] }),
      ctx,
    );
    expect(r.errors[0]).toContain('至少需要');
  });

  it('assert.path 用了非法命名空间', () => {
    const r = validateRule(
      baseRule({
        do: [{ sink: 'gate', assert: { path: 'process.exitCode', op: '==', value: 0 }, onPass: [] }],
      }),
      ctx,
    );
    expect(r.errors[0]).toContain('"result"/"event"');
  });

  it('非法 safety action', () => {
    const r = validateRule(baseRule({ do: [{ sink: 'safety', action: 'explode' }] }), ctx);
    expect(r.errors[0]).toContain('"action" 必须是');
  });

  it('do 为空数组', () => {
    const r = validateRule(baseRule({ do: [] }), ctx);
    expect(r.errors[0]).toContain('非空数组');
  });

  it('gate 嵌套超过深度上限', () => {
    let inner: Record<string, unknown> = { sink: 'safety', action: 'stop' };
    for (let i = 0; i < 7; i++) {
      inner = {
        sink: 'gate',
        assert: { path: 'event.x', op: '==', value: 1 },
        onPass: [inner],
      };
    }
    const r = validateRule(baseRule({ do: [inner] }), ctx);
    expect(r.errors.join()).toContain('嵌套层级超过');
  });

  it('未知 sink', () => {
    const r = validateRule(baseRule({ do: [{ sink: 'teleport', tool: 'say' }] }), ctx);
    expect(r.errors[0]).toContain('未知的 sink');
  });
});
