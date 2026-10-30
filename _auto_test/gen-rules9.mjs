import fs from 'node:fs';
const target = 'C:\\Users\\74689\\.agent\\work\\fence_test.txt';
const rules = [
  {
    id: 'test-t6',
    name: 'T6 围栏坑：invoke write 到工作区外',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 15000 } },
    do: [
      {
        sink: 'invoke',
        tool: 'write',
        args: { file_path: target, content: 'fence-test-' + Date.now() },
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写 T6: time→invoke write→' + target);
