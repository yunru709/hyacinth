import fs from 'node:fs';
const D = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test';
const rules = [
  {
    id: 'test-t6',
    name: 'T6 围栏坑：invoke write 工作区外(含对照)',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 15000 } },
    do: [
      // 对照动作：写工作区内（应成功）——证明规则确实触发执行了
      {
        sink: 'invoke',
        tool: 'bash',
        args: { command: `Add-Content -Path '${D}\\t6_alive.txt' -Value done` },
      },
      // 目标动作：写工作区外（预期被 workspace fence 静默拦截）
      {
        sink: 'invoke',
        tool: 'write',
        args: { file_path: 'C:\\Users\\74689\\.agent\\work\\fence_test.txt', content: 'fence-test-invoke' },
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写 T6(含对照): [bash写区内t6_alive.txt, write写区外fence_test.txt]');
