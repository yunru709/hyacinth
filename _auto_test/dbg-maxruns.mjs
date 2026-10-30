import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAutomationRuntime, dispatchAutomationEvent } from '../dist/automation/service.js';
import { setCurrentAutomationRules, getCurrentAutomationRules } from '../dist/automation/store.js';

const autoPath = path.join(os.homedir(), '.agent', 'automations.json');
const bak = autoPath + '.dbgbak';
const had = fs.existsSync(autoPath);
if (had) fs.copyFileSync(autoPath, bak);
try {
  setCurrentAutomationRules([{ id: 't', name: 't', enabled: true, when: { kind: 'event', event: 'x' }, do: [{ sink: 'invoke', tool: 'bash', args: {} }], maxRuns: 2 }]);
  let calls = 0;
  setAutomationRuntime({ invokeTool: async () => { calls++; return 'ok'; }, wakeSession: async () => {}, armedWatchIds: new Map() });
  const r0 = getCurrentAutomationRules()[0];
  console.log('init: runCount=', JSON.stringify(r0.runCount), 'sameRef=', r0 === getCurrentAutomationRules()[0]);
  const before = getCurrentAutomationRules();
  const o = await dispatchAutomationEvent({ eventName: 'x', source: 't', name: 'x', at: Date.now() });
  const r1 = getCurrentAutomationRules()[0];
  console.log('after1: outcomes=', o.length, 'runCount=', r1.runCount, 'enabled=', r1.enabled, 'calls=', calls, 'sameArrayRef=', before === getCurrentAutomationRules());
  console.log('steps per outcome:', o.map((x) => x.result.steps.length));
} finally {
  if (had) fs.copyFileSync(bak, autoPath); else if (fs.existsSync(autoPath)) fs.unlinkSync(autoPath);
  if (fs.existsSync(bak)) fs.unlinkSync(bak);
}
