// 发行版清理：移除 .map 文件（暴露源码结构）
const fs = require('fs');
const path = require('path');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.map')) fs.unlinkSync(p);
  }
}

walk('dist');
console.log('Source maps cleaned from dist');
