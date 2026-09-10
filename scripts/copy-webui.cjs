// Copy WebUI static assets from src/webui to dist/webui (cross-platform)
const fs = require('fs');
const path = require('path');

function cp(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const sp = path.join(src, f);
    const dp = path.join(dst, f);
    fs.statSync(sp).isDirectory() ? cp(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

cp('src/webui', 'dist/webui');
console.log('WebUI static assets copied to dist/webui');
