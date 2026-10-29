import fs from 'node:fs';
const p = 'C:\\Users\\74689\\.agent\\sessions\\normal\\webui_20261029-180720-9d1083\\conversation.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
// 找第一条 role=user 的原始 JSON
for (let i = 0; i < lines.length; i++) {
  let m; try { m = JSON.parse(lines[i]); } catch { continue; }
  if (m.role === 'user') {
    console.log('=== 第一条 user 消息 raw（截断 1200 字）===');
    console.log(JSON.stringify(m).slice(0, 1200));
    break;
  }
}
