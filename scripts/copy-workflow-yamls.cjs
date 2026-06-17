// Copy builtin workflow YAMLs from src to dist (cross-platform)
const fs = require('fs');
const path = require('path');

const src = 'src/workflow/builtin';
const dst = 'dist/workflow/builtin';

if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });

for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.yaml') || f.endsWith('.yml')) {
    const sp = path.join(src, f);
    const dp = path.join(dst, f);
    fs.copyFileSync(sp, dp);
  }
}

console.log('Workflow YAMLs copied to dist/workflow/builtin');
