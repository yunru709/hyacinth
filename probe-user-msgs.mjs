import fs from 'node:fs';
const p = 'C:\\Users\\74689\\.agent\\sessions\\normal\\webui_20261029-180720-9d1083\\conversation.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
console.log('总消息条数:', lines.length);
let idx = 0;
for (const line of lines) {
  idx++;
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  const role = m.role;
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) text = m.content.map((c) => c.text || c.thinking || '').join(' ');
  // 只关注 user 消息里提到 动作/规则/step/probe 的
  if (role !== 'user') continue;
  if (/动作|规则|step|probe|write-test/i.test(text)) {
    console.log(`\n--- [${idx}] role=${role} ---`);
    console.log(text.slice(0, 700));
  }
}
