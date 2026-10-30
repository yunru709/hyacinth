import fs from 'node:fs';
const D = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test';
const W = 'C:\\Users\\74689\\.agent\\work';
const rules = [
  {
    id: 'test-t6a',
    name: 'T6a 验B: 写 ~/.agent/work 应成功',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 15000 } },
    do: [
      // 对照：证明规则真触发
      { sink: 'invoke', tool: 'bash', args: { command: `Add-Content -Path '${D}\\alive_a.txt' -Value done` } },
      // 目标：写 agent 工作区（B 放行后应成功）
      { sink: 'invoke', tool: 'write', args: { file_path: `${W}\\fence_ok.txt`, content: 'should-exist' } },
    ],
  },
  {
    id: 'test-t6b',
    name: 'T6b 验A: 写真外部应失败并abort',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 15000 } },
    do: [
      // 对照：证明规则真触发
      { sink: 'invoke', tool: 'bash', args: { command: `Add-Content -Path '${D}\\alive_b.txt' -Value done` } },
      // 目标：写真正外部路径（非白名单）⇒ 围栏拦 + runner 识别为 ok:false
      { sink: 'invoke', tool: 'write', args: { file_path: 'C:\\Users\\74689\\fence_bad_test.txt', content: 'should-NOT-exist' } },
      // 探针：若 write 被判失败则 onError=abort，此步不该跑（after_b.txt 不应生成）
      { sink: 'invoke', tool: 'bash', args: { command: `Add-Content -Path '${D}\\after_b.txt' -Value done` } },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写 T6a(验B) + T6b(验A)');
