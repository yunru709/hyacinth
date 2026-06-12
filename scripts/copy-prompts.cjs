// Copy prompts from src to dist (cross-platform)
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

cp('src/prompts', 'dist/prompts');
console.log('Prompts copied to dist/prompts');
