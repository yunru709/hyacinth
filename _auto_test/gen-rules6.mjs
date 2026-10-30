import fs from 'node:fs';
const rules = [
  {
    id: 'test-t2',
    name: 'T2 文件触发寄生会话',
    enabled: true,
    when: {
      kind: 'probe',
      probe: {
        kind: 'file',
        spec: { path: 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test\\t2_trigger.txt', watch: 'mtime' },
        intervalMs: 5000,
      },
    },
    do: [
      {
        sink: 'wake',
        where: { policy: 'reuse', target: { sessionId: 'tui_20261028-224301-2fa2' } },
        prompt: '[自动化测试 T2] 请只回复一句：我被文件变更触发唤醒，证明文件触发+寄生会话生效。不要调用工具。',
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写 T2 规则: file probe(t2_trigger.txt mtime) → wake.reuse(tui_20261028-224301-2fa2)');
