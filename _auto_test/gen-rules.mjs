import fs from 'node:fs';
const data = {
  version: 1,
  rules: [
    {
      id: 'test-t1',
      name: 'T1 无会话定时跑脚本',
      enabled: true,
      when: { kind: 'time', schedule: { intervalMs: 10000 } },
      do: [
        {
          sink: 'invoke',
          tool: 'bash',
          args: {
            command:
              "New-Item -ItemType Directory -Force -Path 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test' | Out-Null; Add-Content -Path 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test\\t1.log' -Value (Get-Date -Format o)",
          },
        },
      ],
    },
  ],
};
const p = process.env.USERPROFILE + '/.agent/automations.json';
fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
console.log('已写:', p);
console.log('--- 内容(前 20 行) ---');
console.log(fs.readFileSync(p, 'utf8').split('\n').slice(0, 20).join('\n'));
console.log('--- BOM 检查: 首字节=', fs.readFileSync(p)[0], '(应为 123 {) ---');
