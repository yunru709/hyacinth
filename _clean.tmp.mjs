// 清理隐私残留（本机用户名 / 本机盘符），带逐项计数自检。用完删。
import fs from 'node:fs';

const USER = 'C:\\Users\\<user>';
const REPS = [
  { file: 'src/diagnostics/doctor.ts', from: 'C:\\Users\\74689', to: USER },
  { file: 'src/tools/xref/manager.ts', from: 'root=C:\\Users\\74689', to: 'root=' + USER },
  { file: 'src/tools/xref/manager.ts', from: 'projectKey=C-Users-74689', to: 'projectKey=C-Users-<user>' },
  { file: 'src/tools/verify-change.ts', from: 'C:\\Users\\74689', to: USER },
  { file: 'src/tts/engines/breeze-server.ts', from: 'F:\\TTSEngines\\audio-cpp', to: '<TTS安装目录>\\audio-cpp' },
  { file: 'src/tts/breeze-models.ts', from: 'F:\\TTSEngines', to: '<TTS安装目录>' },
  { file: 'src/mcp/orphan-sweeper.ts', from: 'F:\\Python3.13\\python.exe', to: 'C:\\Python313\\python.exe' },
  { file: 'src/webui/app.js', from: 'F:\\\\TTSEngines', to: 'C:\\\\TTSEngines' },
  { file: 'src/webui/index.html', from: 'D:\\hyacinth-models', to: 'C:\\hyacinth-models' },
  { file: 'src/runtime/config-schema.ts', from: 'D:\\hyacinth-models', to: 'C:\\hyacinth-models' },
  { file: 'scripts/desktop-package.ps1', from: ", 'F:\\Node\\node.exe'", to: '' },
  { file: 'scripts/desktop-package.ps1', from: 'F:\\Hyacinth', to: 'C:\\Hyacinth' },
];

for (const r of REPS) {
  let txt;
  try { txt = fs.readFileSync(r.file, 'utf8'); } catch (e) { console.log(`SKIP ${r.file}: ${e.message}`); continue; }
  const before = txt;
  const parts = txt.split(r.from);
  const count = parts.length - 1;
  if (count === 0) { console.log(`⚠️ 0 命中 ${r.file} | from=${JSON.stringify(r.from)}`); continue; }
  const out = parts.join(r.to);
  fs.writeFileSync(r.file, out);
  // 写后自检：替换后再读，确认 from 不再出现、且文件可读
  const check = fs.readFileSync(r.file, 'utf8');
  const stillLeft = check.split(r.from).length - 1;
  console.log(`${r.file}: ${count} 处替换, 替换后残留=${stillLeft}`);
}
