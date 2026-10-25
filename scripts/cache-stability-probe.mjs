#!/usr/bin/env node
/**
 * cache-stability-probe.mjs —— 中转站 prefix cache 稳定性探针（2026-10-25）
 *
 * 目的：把「命中率低」拆成三个互斥假设
 *   H1 架构侧-内容：请求体前缀本身在变（段位移 / 内容漂移）
 *   H2 中转站侧：请求体逐字节相同，中转站仍不给缓存
 *   H3 架构侧-路由键：x-opencode-session 每次变 ⇒ 上游路由到不同实例 ⇒ 缓存池隔离
 *
 * 做法：
 *   A 组（纯 provider）：同一请求体 + 同一 session，连发 N 次。
 *     缓存在工作 ⇒ 第 2 次起 cached_tokens ≈ prompt_tokens。
 *   B 组（追加模式）：每轮尾部追加 assistant+user（模拟真实对话）。
 *     理想情况本轮 cached ≈ 上一轮 prompt_tokens。
 *   C 组（路由键敏感性）：同一请求体、换一个 session id 重发 ⇒ 若缓存归零，
 *     证明 session 就是上游缓存的隔离键（H3 成立）。
 *
 * 注意：OpenCode Go 端点**强制**要求 x-opencode-session，缺了直接 400
 * （MissingSessionID / "cannot be routed efficiently"）。
 *
 * ── 2026-10-25 首次实测结论（opencode Go / deepseek-v4.1-flash / 12000 字符固定语料）──
 *   A 组 同请求 ×4     ⇒ 0% → 97.6 / 97.6 / 97.6   （首轮冷启，之后完全稳定）
 *   B 组 追加模式 ×4   ⇒ 97.7 / 97 / 99 / 98.4      （未命中缺口仅 16~113 token = 纯增量）
 *   C 组 换 session id ⇒ 97.6%                      （**session 不是缓存隔离键**）
 *   ⇒ 结论①：中转站 prefix cache 本身健康，H2/H3 均不成立 ⇒ 线上 87~93% 属正常水位。
 *   ⇒ 结论②：`compatible.ts` 里 `OPENCODE_SESSION_ID ?? randomUUID()` 每次实例换 ID
 *      并不会破坏缓存，**无需**为此配环境变量（此前怀疑它导致命中低，已证伪）。
 *   ⇒ 结论③：命中率不封顶的真正原因是「每轮 history 纯追加 ⇒ 增量必然 miss」，
 *      上下文越长、单轮增量越小，命中率越接近上限 —— 与臂长正相关，非故障。
 *   ⚠️ 若要复现，注意该端点强制要求 x-opencode-session（缺了直接 400 MissingSessionID）。
 *
 * 用法：node scripts/cache-stability-probe.mjs [N]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const N = Number(process.argv[2] ?? 4);

function readEnv() {
  const p = path.join(os.homedir(), '.agent', '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...readEnv(), ...process.env };
const key = env.OPENCODE_API_KEY;
if (!key) {
  console.error('缺少 OPENCODE_API_KEY');
  process.exit(2);
}

const BASE = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = process.env.PROBE_MODEL ?? 'deepseek-v4.1-flash';

/** 当前路由键：模拟 hyacinth 的 `process.env.OPENCODE_SESSION_ID ?? randomUUID()` */
let SESSION_ID = env.OPENCODE_SESSION_ID ?? randomUUID();
console.log(`OPENCODE_SESSION_ID 环境变量: ${env.OPENCODE_SESSION_ID ? '已设置' : '未设置 ⇒ 每次实例 randomUUID()'}`);

function buildCorpus(targetChars) {
  const chunk =
    '上下文缓存前缀命中测试：这一段文字用来填充固定的系统提示词，确保其长度超过中转站的最小缓存阈值。' +
    'The quick brown fox jumps over the lazy dog. Prefix caching rewards byte-identical starts. ' +
    '如果把易变的内容放在前缀之前，那么它之后的所有内容都会失效。' +
    '缓存键通常由前缀的 token 序列决定，因此哪怕只差一个字符，后续全部 miss。';
  let s = '';
  let i = 0;
  while (s.length < targetChars) s += `[${i++}] ` + chunk + '\n';
  return s;
}

async function callOnce(messages, tag) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'User-Agent': 'hyacinth-cache-probe',
      'x-opencode-session': SESSION_ID,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 1,
      stream: false,
      temperature: 0,
    }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) return { tag, ok: false, status: res.status, body: text.slice(0, 300), ms };
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { tag, ok: false, status: res.status, body: text.slice(0, 300), ms };
  }
  const u = j.usage ?? {};
  const prompt = u.prompt_tokens ?? 0;
  const hit =
    u.prompt_cache_hit_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    u.cached_tokens ??
    u.cache_hit_tokens ??
    u.cache_read_input_tokens;
  return {
    tag,
    ok: true,
    ms,
    prompt,
    hit: hit ?? null,
    hitPct: hit != null && prompt > 0 ? +((hit / prompt) * 100).toFixed(1) : null,
    rawUsageKeys: Object.keys(u).join(','),
  };
}

function fmt(r) {
  if (!r.ok) return `${r.tag}  ✗ HTTP ${r.status}  ${r.body}`;
  const hitStr = r.hit === null ? 'n/a（无缓存字段）' : `${r.hit} (${r.hitPct}%)`;
  return `${r.tag}  prompt=${r.prompt}  cached=${hitStr}  ${r.ms}ms`;
}

async function main() {
  console.log(`endpoint = ${BASE}`);
  console.log(`model    = ${MODEL}`);
  console.log(`session  = ${SESSION_ID}\n`);

  const corpus = buildCorpus(12000);
  const fixedMsgs = [
    { role: 'system', content: corpus },
    { role: 'user', content: '请只回复一个字符：O' },
  ];

  console.log(`── A 组：完全相同请求 + 同一 session ×${N}（测中转站缓存本身）──`);
  const aResults = [];
  for (let i = 0; i < N; i++) {
    const r = await callOnce(fixedMsgs, `A${i + 1}`);
    aResults.push(r);
    console.log(fmt(r));
  }

  console.log(`\n── B 组：追加模式 ×${N}（测"上一轮全文"能否全中）──`);
  const msgs = [
    { role: 'system', content: corpus },
    { role: 'user', content: '开始计数。' },
  ];
  let prevPrompt = null;
  for (let i = 0; i < N; i++) {
    const r = await callOnce(msgs, `B${i + 1}`);
    if (r.ok && prevPrompt != null) {
      const gap = prevPrompt - (r.hit ?? 0);
      console.log(fmt(r) + `  | 上一轮prompt=${prevPrompt}  未命中缺口=${gap}`);
    } else {
      console.log(fmt(r));
    }
    if (r.ok) prevPrompt = r.prompt;
    msgs.push({ role: 'assistant', content: `计数：${i + 1}。这是第 ${i + 1} 轮的固定回复内容。` });
    msgs.push({ role: 'user', content: `继续，下一轮。当前是第 ${i + 2} 次。` });
  }

  console.log('\n── C 组：同一请求换 session id（验证 session 是否为缓存隔离键）──');
  const oldId = SESSION_ID;
  SESSION_ID = randomUUID();
  console.log(`新 session = ${SESSION_ID}`);
  const c1 = await callOnce(fixedMsgs, 'C1-新session');
  console.log(fmt(c1));
  SESSION_ID = oldId;
  const c2 = await callOnce(fixedMsgs, 'C2-回旧session');
  console.log(fmt(c2));

  console.log('\n── 汇总 ──');
  const okA = aResults.filter((r) => r.ok && r.hit !== null);
  if (okA.length >= 2) {
    const warm = okA.slice(1).map((r) => r.hitPct);
    console.log(`A 组（首轮之后）命中率: ${warm.join(' / ')}`);
    console.log(`  → ${warm.every((v) => v >= 95) ? '稳定 ⇒ 中转站缓存正常（H2 不成立）' : '抖动/偏低 ⇒ 中转站侧可疑（H2 成立）'}`);
  } else {
    console.log('A 组未拿到缓存字段');
  }
  if (c1.ok && c1.hit !== null) {
    console.log(`C 组换 session 后命中: ${c1.hitPct}%  → ${c1.hitPct < 50 ? 'session 是缓存隔离键（H3 成立）' : 'session 不影响缓存（H3 不成立）'}`);
  }
  const usageKeys = aResults.find((r) => r.ok)?.rawUsageKeys;
  if (usageKeys) console.log(`usage 字段: ${usageKeys}`);
}

main().catch((e) => {
  console.error('探针失败:', e.message);
  process.exit(1);
});
