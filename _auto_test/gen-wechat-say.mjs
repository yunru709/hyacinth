import fs from 'node:fs';
// PowerShell 用双引号展开 $env:USERPROFILE；JS 单引号字符串（$ 不插值，\\ = 一个反斜杠）
const deskScript =
  'if (-not (Get-Process -Name Weixin -ErrorAction SilentlyContinue)) { Set-Content -Path "$env:USERPROFILE\\Desktop\\微信已关.txt" -Value "微信已关" -Encoding UTF8 }';
const rules = [
  {
    id: 'wechat-close-to-desktop',
    name: '微信关闭→桌面写文件 + 直接say',
    enabled: true,
    when: {
      kind: 'probe',
      probe: {
        kind: 'process',
        // process probe 单向：只在「新达成 exit」(关闭)触发，打开不触发（watch-service.ts L298-310 已处理方向）
        spec: { name: 'Weixin', expect: 'exit' },
        intervalMs: 3000,
      },
    },
    do: [
      // ① 写桌面文件（bash 不受路径围栏管）
      { sink: 'invoke', tool: 'bash', args: { command: deskScript } },
      // ② 零模型直接 say「微信已关」（invoke say 机械调 say 工具：朗读 + 当前会话落一条文本）
      { sink: 'invoke', tool: 'say', args: { content: '微信已关' } },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写规则: wechat-close-to-desktop → [写桌面文件, say 微信已关]');
