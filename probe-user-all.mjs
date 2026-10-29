import fs from 'node:fs';
const p = 'C:\\Users\\74689\\.agent\\sessions\\normal\\webui_20261029-180720-9d1083\\conversation.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
let idx = 0;
const roles = {};
for (const line of lines) {
  idx++;
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  roles[m.role] = (roles[m.role] || 0) + 1;
  if (m.role !== 'user') continue;
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) text = m.content.map((c) => c.text || '').join(' ');
  console.log(`\n[${idx}] USER (len=${text.length}): ${text.slice(0, 260).replace(/\n/g, ' ')}`);
}
console.log('\n=== 角色分布 ===', JSON.stringify(roles));
