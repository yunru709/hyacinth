// Remove test files from dist (cross-platform)
const fs = require('fs');
const path = require('path');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(fp);
    } else if (e.name.includes('.test.')) {
      fs.unlinkSync(fp);
      console.log('Removed:', fp);
    }
  }
}

try {
  walk('dist');
  console.log('Test files cleaned from dist');
} catch (err) {
  // dist may not exist yet (first build)
  if (err.code !== 'ENOENT') throw err;
}
