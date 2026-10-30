import fs from 'node:fs';
const hit = (tag) => ({
  sink: 'invoke',
  tool: 'bash',
  args: { command: `Add-Content -Path 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test\\t5_hit.log' -Value '${tag}'` },
});
const rules = [
  {
    id: 'test-t1',
    name: 'T1 无会话定时跑脚本',
    enabled: true,
    when: { kind: 'time', schedule: { intervalMs: 10000 } },
    do: [{
      sink: 'invoke',
      tool: 'bash',
      args: { command: "New-Item -ItemType Directory -Force -Path 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test' | Out-Null; Add-Content -Path 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test\\t1.log' -Value (Get-Date -Format o)" },
    }],
  },
  {
    id: 'test-t5-file',
    name: 'T5-file',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'file', spec: { path: 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth\\_auto_test\\t5_file.txt', watch: 'mtime' }, intervalMs: 10000 } },
    do: [hit('file-hit')],
  },
  {
    id: 'test-t5-http',
    name: 'T5-http',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'http', spec: { url: 'http://127.0.0.1:3130/api/health', expectStatus: 200, allowPrivateHost: true }, intervalMs: 10000 } },
    do: [hit('http-hit')],
  },
  {
    id: 'test-t5-process',
    name: 'T5-process',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'process', spec: { name: 'nonexistent_proc_t5', expect: 'running' }, intervalMs: 10000 } },
    do: [hit('process-hit')],
  },
  {
    id: 'test-t5-port',
    name: 'T5-port',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'port', spec: { host: '127.0.0.1', port: 3130, expect: 'open', allowPrivateHost: true }, intervalMs: 10000 } },
    do: [hit('port-hit')],
  },
  {
    id: 'test-t5-uiregion',
    name: 'T5-ui_region',
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'ui_region', spec: { region: [0, 0, 200, 200] }, intervalMs: 10000 } },
    do: [hit('uiregion-hit')],
  },
];
const p = process.env.USERPROFILE + '/.agent/automations.json';
fs.writeFileSync(p, JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
console.log('已写', rules.length, '条规则 →', p);
console.log('首字节(BOM检查)=', fs.readFileSync(p)[0], '(应=123)');
