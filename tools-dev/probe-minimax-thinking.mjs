/**
 * 探针：commandcode 的 minimax-m3.1-flash:free 到底怎么"思考"？
 *
 * 要回答三件事（对应 thinking-style.ts 的 effort / effort-required 之争）：
 *   ① 完全不发 reasoning_effort ⇒ 上游默认思考吗？（决定 effort-required 的语义是否为"恒定思考"）
 *   ② 发 reasoning_effort:'high' ⇒ 有 reasoning_content 吗？（决定能否真开起来）
 *   ③ 发 reasoning_effort:'off'  ⇒ 400 吗？（复核 2026-10-21 那条实测结论）
 *
 * 用法：node tools-dev/probe-minimax-thinking.mjs [modelId]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL = process.argv[2] ?? 'minimax/minimax-m3.1-flash:free';
const BASE = 'https://api.commandcode.ai/provider/v1';

function loadKey() {
  const p = path.join(os.homedir(), '.agent', '.env');
  const txt = fs.readFileSync(p, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*COMMANDCODE_API_KEY\s*=\s*(.+)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('COMMANDCODE_API_KEY not found in ~/.agent/.env');
}

const KEY = loadKey();

async function probe(label, extraBody) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'What is 17*23? Answer with the number only.' }],
    stream: false,
    max_tokens: 4096,
    ...extraBody,
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
        'User-Agent': 'hyacinth-probe/1.0',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`\n### ${label}\n  FETCH ERROR: ${e.message}`);
    return;
  }
  const ms = Date.now() - t0;
  const raw = await res.text();
  console.log(`\n### ${label}`);
  console.log(`  status=${res.status} (${ms}ms) model=${MODEL}`);
  console.log(`  body.reasoning_effort=${JSON.stringify(extraBody.reasoning_effort)}`);
  if (!res.ok) {
    console.log(`  ERROR BODY: ${raw.slice(0, 600)}`);
    return;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    console.log(`  NON-JSON: ${raw.slice(0, 400)}`);
    return;
  }
  const msg = j.choices?.[0]?.message ?? {};
  const rc = msg.reasoning_content;
  const rcDetail = msg.reasoning; // 某些网关用 reasoning / reasoning_details
  console.log(`  content: ${JSON.stringify(String(msg.content ?? '').slice(0, 120))}`);
  console.log(`  reasoning_content: ${rc === undefined ? '<absent>' : `len=${String(rc).length} :: ${JSON.stringify(String(rc).slice(0, 160))}`}`);
  if (rcDetail !== undefined) {
    console.log(`  reasoning(field): ${JSON.stringify(rcDetail).slice(0, 200)}`);
  }
  console.log(`  usage: ${JSON.stringify(j.usage ?? {})}`);
  console.log(`  top-level keys of message: ${Object.keys(msg).join(',')}`);
}

console.log(`=== probe ${MODEL} @ ${BASE} ===`);
await probe('A. 不发任何思考字段（基线）', {});
await probe('B. reasoning_effort=high', { reasoning_effort: 'high' });
await probe('C. reasoning_effort=off', { reasoning_effort: 'off' });
