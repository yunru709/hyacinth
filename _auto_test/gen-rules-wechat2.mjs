import fs from 'node:fs';
// 桌面文件写入（上次已验证成功，保留）+ 新增 say 播报。process probe 已单向（只在关闭触发）。
const writeScript =
  'if (-not (Get-Process -Name Weixin -ErrorAction SilentlyContinue)) { Set-Content -Path "$env:USERPROFILE\\Desktop\\微信已关.txt" -Value "微信已关" -Encoding UTF8 }';
const rules = [
  {
    id: 'wechat-close',
    name: '微信关闭→写桌面文件+say',
    enabled: true,
    when: {
      kind: 'probe',
      probe: { kind: 'process', spec: { name: 'Weixin', expect: 'exit' }, intervalMs: 3000 },
    },
    do: [
      { sink: 'invoke', tool: 'bash', args: { command: writeScript } },
      { sink: 'invoke', tool: 'say', args: { content: '微信已关' } },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写: 微信关闭 → [invoke bash 写桌面文件, invoke say 微信已关]');
