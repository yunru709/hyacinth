import { runRule } from '../dist/automation/runner.js';

let calls = 0;
const ctx = {
  invokeTool: async () => { calls++; return String(calls); },
  wakeSession: async () => {},
};

async function run(tag, doArr, expect) {
  calls = 0;
  const r = await runRule(
    { id: tag, name: tag, enabled: true, when: { kind: 'event', event: 'x' }, do: doArr },
    { source: 'test', name: 'x', at: Date.now() },
    ctx,
  );
  const pass = r.ok && calls === expect;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${tag}: ok=${r.ok} calls=${calls} (expect ${expect})${r.error ? ' err=' + r.error : ''}`);
  return pass;
}

let all = true;
// 1. 固定 3 轮
all = (await run('times=3', [{ sink: 'loop', do: [{ sink: 'invoke', tool: 'bash' }], times: 3 }], 3)) && all;
// 2. until: 累计结果 >=3 就退出（跑 3 轮）
all = (await run('until>=3', [{ sink: 'loop', do: [{ sink: 'invoke', tool: 'bash' }], until: { path: 'result', op: '>=', value: 3 }, maxIterations: 100 }], 3)) && all;
// 3. maxIterations 兜底：while 条件永真 -> 上限 5 轮停
all = (await run('cap=5', [{ sink: 'loop', do: [{ sink: 'invoke', tool: 'bash' }], while: { path: 'result', op: '!=', value: 'never' }, maxIterations: 5 }], 5)) && all;
// 4. 入口 invoke + loop 2 轮 + 退出 invoke => 共 4 次
all = (await run('entry+loop2+exit', [
  { sink: 'invoke', tool: 'bash' },
  { sink: 'loop', do: [{ sink: 'invoke', tool: 'bash' }], times: 2 },
  { sink: 'invoke', tool: 'bash' },
], 4)) && all;
// 5. 循环体失败（abort）应中止
calls = 0;
let failCtx = { invokeTool: async () => { calls++; throw new Error('boom'); }, wakeSession: async () => {} };
const r5 = await runRule(
  { id: 'fail', name: 'fail', enabled: true, when: { kind: 'event', event: 'x' }, do: [
    { sink: 'loop', do: [{ sink: 'invoke', tool: 'bash' }], times: 5 },
  ] },
  { source: 'test', name: 'x', at: Date.now() },
  failCtx,
);
const p5 = r5.ok === false && calls === 1;
console.log(`${p5 ? 'PASS' : 'FAIL'} loop-fail-abort: ok=${r5.ok} calls=${calls} (expect false,1)`);
all = all && p5;

console.log(all ? '\n=== ALL PASS ===' : '\n=== SOME FAILED ===');
