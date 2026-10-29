import fs from 'node:fs';
import path from 'node:path';
import { validateRule } from './dist/automation/validate.js';
import { WriteTool } from './dist/tools/write.js';

const home = process.env.USERPROFILE || process.env.HOME;
const j = JSON.parse(fs.readFileSync(path.join(home, '.agent', 'automations.json'), 'utf8'));
const raw = j.rules.find((x) => x.id === 'e2e-step2');
console.log('=== 原始 do（文件里）===');
console.log(JSON.stringify(raw.do, null, 2));

const ctx = {
  knownProbeKinds: ['file', 'http', 'process', 'port', 'ui_region'],
  knownToolNames: ['write', 'bash', 'say', 'read', 'edit', 'grep', 'glob', 'http_request', 'watch_start'],
  knownHandlers: [],
  knownEvents: ['beforeTurn', 'afterTurn', 'afterWatch', 'afterScheduleTask'],
};
const res = validateRule(raw, ctx);
console.log('=== validate errors ===', res.errors);
console.log('=== validate 后的 do ===');
console.log(JSON.stringify(res.rule ? res.rule.do : null, null, 2));

// 若 validate 后 args 还在，直接拿 write 动作的 args 调 WriteTool
if (res.rule) {
  const wa = res.rule.do.find((a) => a.sink === 'invoke' && a.tool === 'write');
  if (wa) {
    console.log('=== 用 validate 后的 write action.args 调 WriteTool ===');
    console.log('args =', JSON.stringify(wa.args));
    const w = new WriteTool();
    const out = await w.execute(wa.args || {});
    console.log('WriteTool 返回:', String(out).split('\n')[0]);
    console.log('step2.txt 存在:', fs.existsSync(wa.args.file_path));
  }
}
