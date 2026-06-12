const { LayeredContextComposer } = require('../dist/context/composer.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));

async function main() {
  const composer = new LayeredContextComposer(200000);

  composer.registerSource({
    name: 'tool-bundles', strategy: 'always_inline', cacheability: 'manifest',
    description: '工具包索引',
    getContent: () => '- all: 全量工具包\n- common: 通用工具包 — 18 个常用工具',
  });
  composer.registerSource({
    name: 'tool-bundle-expand', strategy: 'always_inline', cacheability: 'live',
    description: '当前工具包展开',
    getContent: () => '当前工具包 (common):\n' + ['read','write','edit','bash','glob','grep','task_start','task_mark','interrupt','list_bundles','activate_bundle','deactivate_bundle','create_bundle','add_to_bundle','remove_from_bundle','delete_bundle','list_tasks','mcp_status'].map(t => '- ' + t + ': 工具').join('\n'),
  });

  function nums(n) { const a = []; for (let i = 1; i <= n; i++) a.push(i); return a.join(', '); }
  function prefixLen(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

  const START = 500, END = 600, STEP = 10;
  let prev = '';

  console.log('Round | Msgs | Full bytes | Prefix | Hit%');
  console.log('-'.repeat(60));

  for (let n = START; n <= END; n += STEP) {
    const r = await composer.compose({
      sessionDir: tmpDir, maxContextTokens: 200000, cwd: tmpDir,
      timestamp: '2026-06-10 14:30:00',
      tools: [{name:'read',description:'Read',input_schema:{type:'object',properties:{},required:[]}},{name:'write',description:'Write',input_schema:{type:'object',properties:{},required:[]}},{name:'bash',description:'Bash',input_schema:{type:'object',properties:{},required:[]}}],
      history: [], userInput: nums(n),
    });

    const s = JSON.stringify(r.messages, null, 0);
    const pl = prev ? prefixLen(prev, s) : 0;
    const pct = prev ? (pl / s.length * 100).toFixed(1) : '---';

    console.log(`  ${String(n).padStart(4)} | ${String(r.messages.length).padStart(3)}  | ${String(s.length).padStart(9)} | ${String(pl).padStart(6)} | ${pct}%`);

    prev = s;
  }

  const testResult = await composer.compose({
    sessionDir: tmpDir, maxContextTokens: 200000, cwd: tmpDir,
    timestamp: '2026-06-10 14:30:00',
    tools: [{name:'read',description:'R',input_schema:{type:'object',properties:{},required:[]}}],
    history: [], userInput: nums(550),
  });

  const roles = testResult.messages.map(m => m.role).join(' | ');
  const sysCount = testResult.messages.filter(m => m.role === 'system').length;
  console.log(`\nZone structure: ${roles}`);
  console.log(`System messages: ${sysCount} (expect 1)`);
  console.log(`Total messages: ${testResult.messages.length}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });
