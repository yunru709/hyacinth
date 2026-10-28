// 生成 assets/bg/_manifest.json：{ <主题id>: <实际存在的文件名> }
// 前端 probeUserBg 先读它、只请求存在的背景图 ⇒ 缺图不再产生 404（2026-10-28）。
// 由 build 链在 copy-webui 之前调用（package.json build）；也写 dist 便于直接同步。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const bgDir = path.join(root, 'src', 'webui', 'assets', 'bg');
const exts = ['webp', 'jpg', 'jpeg', 'png']; // 优先级：webp 最高
const map = {};
try {
  for (const f of fs.readdirSync(bgDir)) {
    const m = /^(.+)\.(webp|jpg|jpeg|png)$/i.exec(f);
    if (!m) continue;
    const id = m[1];
    const ext = m[2].toLowerCase();
    const cur = map[id] ? map[id].split('.').pop() : null;
    if (!cur || exts.indexOf(ext) < exts.indexOf(cur)) map[id] = `${id}.${ext}`;
  }
} catch (e) {
  console.warn('[gen-bg-manifest] read bg dir failed:', e && e.message);
}
const json = JSON.stringify(map, null, 2) + '\n';
fs.writeFileSync(path.join(bgDir, '_manifest.json'), json, 'utf8');
const distBg = path.join(root, 'dist', 'webui', 'assets', 'bg');
if (fs.existsSync(distBg)) fs.writeFileSync(path.join(distBg, '_manifest.json'), json, 'utf8');
console.log('[gen-bg-manifest] ' + (Object.keys(map).length) + ' bg(s): ' + JSON.stringify(map));
