// Copy prompts from src to dist (cross-platform)
const fs = require('fs');
const path = require('path');
const os = require('os');

function cp(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const sp = path.join(src, f);
    const dp = path.join(dst, f);
    fs.statSync(sp).isDirectory() ? cp(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

cp('src/prompts', 'dist/prompts');
cp('src/tools/builtin', path.join(os.homedir(), '.agent', 'tools'));
console.log('Builtin Python tools copied to ~/.agent/tools');
console.log('Prompts copied to dist/prompts');
