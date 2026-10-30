import fs from 'node:fs';
import { validateRule } from '../dist/automation/validate.js';
const j = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.agent/automations.json', 'utf8'));
const ctx = {
  knownProbeKinds: ['file', 'http', 'process', 'port', 'ui_region'],
  knownToolNames: ['bash', 'write', 'say', 'read', 'edit', 'grep', 'glob', 'http_request', 'watch_start', 'deliver'],
  knownHandlers: [],
  knownEvents: [],
};
for (const id of ['test-t4-pass', 'test-t4-fail']) {
  const r = j.rules.find((x) => x.id === id);
  if (!r) { console.log(id, '=> 文件里没这条'); continue; }
  const res = validateRule(r, ctx);
  console.log(id, '=>', res.rule ? 'OK' : 'REJECTED', '| errors:', JSON.stringify(res.errors));
}
