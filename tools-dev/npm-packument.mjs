// npm-packument.mjs —— 直接问 registry 拿包的版本列表与依赖声明（绕开 npm CLI 的证书问题）
// 用法: node npm-packument.mjs <pkg> [显示最近 N 个版本，默认 8]
const pkg = process.argv[2];
const n = Number(process.argv[3] || 8);
if (!pkg) { console.error('usage: node npm-packument.mjs <pkg> [n]'); process.exit(2); }
const res = await fetch('https://registry.npmjs.org/' + encodeURIComponent(pkg).replace('%40', '@'), {
  headers: { accept: 'application/json' },
});
console.log('HTTP ' + res.status);
if (!res.ok) { console.log(await res.text().then((t) => t.slice(0, 400))); process.exit(1); }
const j = await res.json();
const vs = Object.keys(j.versions || {});
console.log('dist-tags = ' + JSON.stringify(j['dist-tags']));
console.log('total versions = ' + vs.length);
for (const v of vs.slice(-n)) {
  const p = j.versions[v];
  const pick = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith('@deepseek-ai') || k.startsWith('dsh'))) : {});
  console.log('--- ' + v + '   (published ' + (j.time?.[v] ?? '?') + ')');
  console.log('    dependencies(@deepseek-ai/dsh*) = ' + JSON.stringify(pick(p.dependencies)));
  console.log('    peerDependencies(@deepseek-ai/dsh*) = ' + JSON.stringify(pick(p.peerDependencies)));
  if (p.dsh) console.log('    dsh field = ' + JSON.stringify(p.dsh));
}
