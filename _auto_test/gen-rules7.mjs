import fs from 'node:fs';
const pid = Number(fs.readFileSync('_auto_test/t3_pid.txt', 'utf8').trim());
const rules = [
  {
    id: 'test-t3',
    name: 'T3 进程退出→空白会话',
    enabled: true,
    when: {
      kind: 'probe',
      probe: { kind: 'process', spec: { pid, expect: 'exit' }, intervalMs: 5000 },
    },
    do: [
      {
        sink: 'wake',
        where: { policy: 'new', ttlMs: 60000 },
        prompt: '[自动化测试 T3] 请只回复一句：我被进程退出触发唤醒，这是临时空白会话，用完即弃。不要调用工具。',
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写 T3 规则: process pid=' + pid + ' expect=exit → wake.new(ttlMs=60000)');
