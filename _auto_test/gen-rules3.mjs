import fs from 'node:fs';
const D = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test';
const append = (file, val) => ({
  sink: 'invoke',
  tool: 'bash',
  args: { command: `Add-Content -Path '${D}\\${file}' -Value '${val}'` },
});
const rules = [
  // T4a：42 > 10 = true → 应走 onPass
  {
    id: 'test-t4-pass',
    name: 'T4a gate onPass (42>10)',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 15000 } },
    do: [
      { sink: 'invoke', tool: 'bash', args: { command: 'Write-Output 42' } },
      {
        sink: 'gate',
        assert: { path: 'result', op: '>', value: 10 },
        onPass: [append('gate_pass.txt', 'PASS-42>10')],
        onFail: [append('gate_fail.txt', 'FAILonPass-42>10')],
      },
    ],
  },
  // T4b：42 > 100 = false → 应走 onFail
  {
    id: 'test-t4-fail',
    name: 'T4b gate onFail (42>100)',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 15000 } },
    do: [
      { sink: 'invoke', tool: 'bash', args: { command: 'Write-Output 42' } },
      {
        sink: 'gate',
        assert: { path: 'result', op: '>', value: 100 },
        onPass: [append('gate2_pass.txt', 'PASSonFail-42>100')],
        onFail: [append('gate2_fail.txt', 'FAIL-42>100')],
      },
    ],
  },
  // 保留 ui_region 一条，验证 bug2 修复（lastError 应消失）
  {
    id: 'test-t5-uiregion',
    name: 'T5-ui_region 验证bug2修复',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'ui_region', spec: { region: [0, 0, 200, 200] }, intervalMs: 10000 } },
    do: [append('t5_hit.log', 'uiregion-hit')],
  },
  // 保留 T1，验证跨重启 time 规则仍跑
  {
    id: 'test-t1',
    name: 'T1 无会话跑脚本',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 10000 } },
    do: [{
      sink: 'invoke',
      tool: 'bash',
      args: { command: `New-Item -ItemType Directory -Force -Path '${D}' | Out-Null; Add-Content -Path '${D}\\t1.log' -Value (Get-Date -Format o)` },
    }],
  },
];
fs.writeFileSync(process.env.USERPROFILE + '/.agent/automations.json', JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写', rules.length, '条:', rules.map((r) => r.id).join(', '));
