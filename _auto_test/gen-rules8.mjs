import fs from 'node:fs';
const rules = [
  {
    id: 'test-t3',
    name: 'T3 time触发→空白会话用完销毁',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 30000 } },
    do: [
      {
        sink: 'wake',
        where: { policy: 'new', ttlMs: 60000 },
        prompt: '[自动化测试 T3] 请只回复一句：我是空白临时会话，用完即弃。不要调用工具。',
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写 T3(time interval30s → wake.new ttlMs=60000)');
