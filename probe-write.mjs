import { WriteTool } from './dist/tools/write.js';
import fs from 'node:fs';

const w = new WriteTool();
const p = 'C:\\Users\\74689\\.agent\\work\\automation-e2e\\probe-test-' + Date.now() + '.txt';
const r = await w.execute({ file_path: p, content: 'probe hello from WriteTool' });
console.log('返回:', JSON.stringify(r));
console.log('文件存在:', fs.existsSync(p), 'path=', p);
