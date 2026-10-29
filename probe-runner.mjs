import fs from 'node:fs';
import path from 'node:path';
import { runRule } from './dist/automation/runner.js';
import { WriteTool } from './dist/tools/write.js';

const home = process.env.USERPROFILE || process.env.HOME;
const j = JSON.parse(fs.readFileSync(path.join(home, '.agent', 'automations.json'), 'utf8'));
const rule = j.rules.find((x) => x.id === 'e2e-step2');
console.log('规则 do 长度:', rule.do.length);

const event = { eventName: 'afterWatch:file', source: 'watch', name: 'e2e-step2', at: Date.now(), payload: {} };

const ctx = {
  invokeTool: async (toolName, args) => {
    console.log('>>> INVOKE tool=%s  args=%s', toolName, JSON.stringify(args));
    if (toolName === 'write') {
      const w = new WriteTool();
      const r = await w.execute(args);
      console.log('    write 返回首行:', String(r).split('\n')[0]);
      return r;
    }
    console.log('    (非 write 工具，probe 里不真执行)');
    return 'skipped-in-probe';
  },
  wakeSession: async () => {},
};

const result = await runRule(rule, event, ctx);
console.log('=== runRule 结果 steps ===');
console.log(JSON.stringify(result.steps ?? result, null, 2));
