const fs = require('fs');
const path = require('path');
const d = new Date();
const ts = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
const dest = `C:/Users/74689/Desktop/deepthink-src-backup-${ts}`;
const skip = new Set(['node_modules', 'dist', '.git', '.claude', '.trae']);

function cp(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (skip.has(f)) continue;
    const sp = path.join(src, f), dp = path.join(dest, f);
    fs.statSync(sp).isDirectory() ? cp(sp, dp) : fs.copyFileSync(sp, dp);
  }
}

cp('C:/Users/74689/Desktop/Agent/agent', dest);
console.log('Backup:', dest);
