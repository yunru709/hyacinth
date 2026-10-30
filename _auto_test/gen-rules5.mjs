import fs from 'node:fs';
const rules = [
  {
    id: 'test-t2b',
    name: 'T2b 定时器寄生会话',
    enabled: true,
    // 每 30s 触发一次；跑 1-2 次验证即可
    when: { kind: 'time', schedule: { intervalMs: 30000 } },
    do: [
      {
        sink: 'wake',
        // reuse=续指定会话历史；target 用一条空闲旧 tui 会话（不干扰当前 webui 对话）
        where: { policy: 'reuse', target: { sessionId: 'tui_20261025-202839-37e3' } },
        prompt: '[自动化测试 T2b] 请只回复一句话：我（模型）是被定时器唤醒的，证明寄生会话生效。不要调用任何工具。',
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写', rules.length, '条: T2b (target=tui_20261025-202839-37e3)');
