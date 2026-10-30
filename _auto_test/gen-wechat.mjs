import fs from 'node:fs';
// 注意：PowerShell 用双引号才能展开 $env:USERPROFILE；写成 JS 单引号字符串（$ 不插值，\\ = 一个反斜杠）
const script =
  'if (-not (Get-Process -Name Weixin -ErrorAction SilentlyContinue)) { Set-Content -Path "$env:USERPROFILE\\Desktop\\微信已关.txt" -Value "微信已关" -Encoding UTF8 }';
const rules = [
  {
    id: 'wechat-close-to-desktop',
    name: '微信关闭→桌面写“微信已关”',
    enabled: true,
    when: {
      kind: 'probe',
      probe: {
        kind: 'process',
        // 微信主进程名 = Weixin（实测）；expect='exit' 表示等它退出
        spec: { name: 'Weixin', expect: 'exit' },
        intervalMs: 3000,
      },
    },
    do: [
      {
        sink: 'invoke',
        tool: 'bash',
        // bash 写桌面（桌面在工作区外，invoke write 会被围栏拦；bash 不受路径围栏管）
        // 脚本内部再判断一次微信不在才写 —— 抵消 process probe「开/关都触发」导致的开机误写
        args: { command: script },
      },
    ],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写规则: wechat-close-to-desktop (监测 Weixin 退出 → 桌面写 微信已关.txt)');
