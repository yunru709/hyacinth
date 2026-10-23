// asar-ls.mjs —— 列出 Electron .asar 归档内的条目（自解析头部，零依赖）
// 用法: node asar-ls.mjs <file.asar> [regex过滤] [最多行数]
// asar 头部布局: [0..7] 外层 pickle(uint32 payload=4, uint32 size)
//                [8..11] header pickle 载荷大小  [12..15] JSON 字符串长度  [16..] JSON
import fs from 'node:fs';
const [file, pat, maxRows] = process.argv.slice(2);
if (!file) { console.error('usage: node asar-ls.mjs <file.asar> [regex] [maxRows]'); process.exit(2); }
const fd = fs.openSync(file, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const raw = jsonBuf.toString('utf8');
const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
const rows = [];
(function walk(node, prefix) {
  if (node.files) { for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name); }
  else { rows.push({ path: prefix, size: node.size || 0 }); }
})(header, '');
const re = pat ? new RegExp(pat) : null;
const hit = re ? rows.filter(r => re.test(r.path)) : rows;
hit.sort((a, b) => a.path.localeCompare(b.path));
console.log('file=' + file + '  total=' + rows.length + '  matched=' + hit.length);
const n = Math.min(hit.length, Number(maxRows) || 200);
for (let i = 0; i < n; i++) console.log(String(hit[i].size).padStart(10) + '  ' + hit[i].path);
if (hit.length > n) console.log('... (' + (hit.length - n) + ' more)');
