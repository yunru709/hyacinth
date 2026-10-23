// asar-cat.mjs —— 从 .asar 归档取出单个文件内容（自解析头部，零依赖）
// 用法: node asar-cat.mjs <file.asar> <归档内路径 如 /dsh/package.json> [最多字节]
// 头部布局: [0..3] 外层 pickle 长度=4  [4..7] header pickle 载荷长  [8..11] 字符串 pickle 载荷长
//           [12..15] JSON 字符串长度     [16..] JSON
// 数据段起点 = 8 + headerPayload；文件偏移相对数据段起点。
import fs from 'node:fs';
const [file, target, maxOut] = process.argv.slice(2);
if (!file || !target) { console.error('usage: node asar-cat.mjs <file.asar> <inner/path> [maxBytes]'); process.exit(2); }
const fd = fs.openSync(file, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPayload = head.readUInt32LE(4);
const dataStart = 8 + headerPayload;
const jsonSize = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonSize);
fs.readSync(fd, jb, 0, jsonSize, 16);
const raw = jb.toString('utf8');
const tree = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
let node = tree;
for (const p of target.split('/').filter(Boolean)) {
  node = node && node.files ? node.files[p] : null;
  if (!node) { console.error('NOT FOUND: ' + p + '  (in ' + target + ')'); process.exit(1); }
}
if (node.files) { console.error('IS A DIRECTORY: ' + target); process.exit(1); }
const len = Math.min(Number(node.size), Number(maxOut) || 200000);
const buf = Buffer.alloc(len);
fs.readSync(fd, buf, 0, len, dataStart + Number(node.offset));
console.error('// extracted ' + target + '  size=' + node.size + '  shown=' + len);
process.stdout.write(buf.toString('utf8'));
