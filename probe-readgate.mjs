import { WriteTool } from './dist/tools/write.js';
import fs from 'node:fs';

const p = 'C:\\Users\\74689\\.agent\\work\\automation-e2e\\step2b.txt';
const w = new WriteTool();

// 1. 新建（无门控，应成功）
const r1 = await w.execute({ file_path: p, content: 'AAA first write' });
console.log('1 新建:', String(r1).split('\n')[0]);

// 2. 模拟"外部进程"修改文件（mtime 前进 >50ms）
await new Promise((r) => setTimeout(r, 120));
fs.writeFileSync(p, 'EXTERNAL MODIFY', 'utf8');
await new Promise((r) => setTimeout(r, 120));

// 3. 再次用 WriteTool 写（file-tracker 认为被外部改过 → read-gate 应拒绝）
const r3 = await w.execute({ file_path: p, content: 'BBB robot write' });
console.log('3 再写返回:', String(r3).split('\n')[0]);
console.log('3 后文件实际内容:', JSON.stringify(fs.readFileSync(p, 'utf8')));
console.log('   → 若内容仍是 EXTERNAL MODIFY 且返回含"拒绝/未读/stale" = read-gate 拦截确认');
