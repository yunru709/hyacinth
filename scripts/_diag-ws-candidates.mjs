import fs from 'node:fs';
const { buildWsCandidates } = await import('../dist/channels/plugins/qq/qq-client.js');

console.log('[1] buildWsCandidates("ws://127.0.0.1:3001") =', JSON.stringify(buildWsCandidates('ws://127.0.0.1:3001')));
console.log('[2] buildWsCandidates("ws://localhost:3001") =', JSON.stringify(buildWsCandidates('ws://localhost:3001')));

const s = fs.readFileSync('dist/channels/plugins/qq/qq-client.js', 'utf8');
const i = s.indexOf(".on('close'");
console.log('\n[3] dist close handler 片段:');
console.log(s.slice(i - 60, i + 620));
