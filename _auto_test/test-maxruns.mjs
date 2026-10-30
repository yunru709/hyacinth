import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAutomationRuntime, dispatchAutomationEvent } from '../dist/automation/service.js';
import { setCurrentAutomationRules, getCurrentAutomationRules } from '../dist/automation/store.js';

const autoPath = path.join(os.homedir(), '.agent', 'automations.json');
const backup = autoPath + '.testbak';
const had = fs.existsSync(autoPath);
if (had) fs.copyFileSync(autoPath, backup);

let pass = true;
try {
  setCurrentAutomationRules([{
    id: 't-maxruns', name: 't-maxruns', enabled: true,
    when: { kind: 'event', event: 'x' },
    do: [{ sink: 'invoke', tool: 'bash', args: {} }],
    maxRuns: 2,
  }]);
  let calls = 0;
  setAutomationRuntime({ invokeTool: async () => { calls++; return 'ok'; }, wakeSession: async () => {}, armedWatchIds: new Map() });

  const ev = { eventName: 'x', source: 'test', name: 'x', at: Date.now() };
  const o1 = await dispatchAutomationEvent(ev);
  const s1 = getCurrentAutomationRules()[0];
  const o2 = await dispatchAutomationEvent(ev);
  const s2 = getCurrentAutomationRules()[0];
  const o3 = await dispatchAutomationEvent(ev);

  console.log(`dispatch1: outcomes=${o1.length} runCount=${s1.runCount} enabled=${s1.enabled} (expect 1/1/true)`);
  console.log(`dispatch2: outcomes=${o2.length} runCount=${s2.runCount} enabled=${s2.enabled} (expect 1/2/false)`);
  console.log(`dispatch3: outcomes=${o3.length} (expect 0: 停用后不匹配)`);
  console.log(`invoke calls=${calls} (expect 2)`);
  pass = o1.length === 1 && s1.runCount === 1 && s1.enabled === true
      && o2.length === 1 && s2.runCount === 2 && s2.enabled === false
      && o3.length === 0 && calls === 2;

  // 磁盘持久化：runCount=2, enabled=false 应已落盘
  const disk = JSON.parse(fs.readFileSync(autoPath, 'utf8'));
  const d = disk.rules.find((r) => r.id === 't-maxruns');
  console.log(`disk runCount=${d && d.runCount} enabled=${d && d.enabled} (expect 2/false)`);
  pass = pass && d && d.runCount === 2 && d.enabled === false;
} finally {
  if (had) fs.copyFileSync(backup, autoPath); else if (fs.existsSync(autoPath)) fs.unlinkSync(autoPath);
  if (fs.existsSync(backup)) fs.unlinkSync(backup);
}
console.log(pass ? '\n=== PASS ===' : '\n=== FAIL ===');
