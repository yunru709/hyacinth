// dsh-resolve-probe.mjs —— 复现 dsh 加载器的解析逻辑：从"安装锚点"与"profile 锚点"分别解析插件名，
// 打印每个候选目录里那份 package.json 的版本。用来判定 profile-local 副本是否会遮住应用自带的那份。
// 必须用 dsh 自带的 node 跑（能读 asar）：
//   $env:DSH_DESKTOP_NODE_EXECUTABLE='F:\DSH\DeepSeek Harness.exe'
//   cmd /c "F:\DSH\resources\runtime\bin\node.cmd <本文件>"
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const names = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-mcp-resources',
];
const anchors = {
  install: 'F:/DSH/resources/app.asar/dsh/package.json',
  profile: 'C:/Users/74689/.dsh/profiles/desktop/package.json',
};

function versionAt(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? '?'; }
  catch { return '?'; }
}

for (const [label, anchor] of Object.entries(anchors)) {
  console.log('=== anchor ' + label + '  (' + anchor + ')');
  let req;
  try { req = createRequire(anchor); } catch (e) { console.log('  createRequire failed: ' + e.message); continue; }
  for (const n of names) {
    const tried = [];
    let hit = null;
    let paths = [];
    try { paths = req.resolve.paths(n) ?? []; } catch (e) { console.log('  resolve.paths failed for ' + n + ': ' + e.message); continue; }
    for (const sp of paths) {
      const cand = path.join(sp, n);
      let exists = false;
      try { exists = fs.existsSync(path.join(cand, 'package.json')); } catch { exists = false; }
      tried.push((exists ? '[HIT] ' : '[   ] ') + cand);
      if (exists && hit === null) hit = cand;
    }
    console.log('  ' + n + '  ->  ' + (hit === null ? '(none)' : hit + '  @' + versionAt(hit)));
    if (process.env.DSH_PROBE_VERBOSE === '1') for (const t of tried) console.log('        ' + t);
  }
}
