/**
 * diff-channel.test.ts — diff 账本的契约（Phase 6 B1 增记"结构事实"）
 *
 * 为什么测试这个：账本是**跨模块的结构事实通道**（write/edit 写、executor 读），
 * 而 Phase 6 把引用自检搬到后置消费者之后，它**依赖账本里的 before/after** 才能工作
 *（工具在写出前手上有全文；后置消费者那时磁盘上已是新内容，反推不出来）。
 * 这条依赖是隐性的，故用测试把它显式钉住。
 */
import { describe, expect, it } from 'vitest';
import { pushDiff, popDiff } from './diff-channel.js';

describe('diff 账本', () => {
  it('pop 即消费（一次性），再 pop 得到 undefined', () => {
    pushDiff('/tmp/ledger-a.ts', []);
    expect(popDiff('/tmp/ledger-a.ts')).toBeTruthy();
    expect(popDiff('/tmp/ledger-a.ts')).toBeUndefined();
  });

  it('可携带结构事实 before/after —— 引用自检消费者据此推导，无需反推', () => {
    pushDiff('/tmp/ledger-b.ts', [], { before: 'const a = 1;\n', after: 'const a = 2;\n' });
    const e = popDiff('/tmp/ledger-b.ts');
    expect(e?.before).toBe('const a = 1;\n');
    expect(e?.after).toBe('const a = 2;\n');
    expect(e?.filePath).toBe('/tmp/ledger-b.ts');
  });

  it('不传 texts 时字段缺省（向后兼容：既有 UI 消费者忽略新字段）', () => {
    pushDiff('/tmp/ledger-c.ts', []);
    const e = popDiff('/tmp/ledger-c.ts');
    expect(e?.before).toBeUndefined();
    expect(e?.after).toBeUndefined();
  });
});
