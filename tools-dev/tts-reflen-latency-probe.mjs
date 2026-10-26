/**
 * 对照实验：**参考音「时长」本身是否影响合成耗时？**
 *
 * 上一轮探针发现 FlutterShy(3.85s) 比 zh-test(2.73s) 慢 1.1s，但两者同时差在
 * 时长(15.86 vs 3.48)、采样率(44.1k vs 24k)、声道(2 vs 1)、文本(180 vs 15 字)。
 * 混杂太多，不能归因。
 *
 * 本实验只动一个变量：同一份 FlutterShy 录音，裁成 3.5s / 8s / 15.86s 三档，
 * 采样率与声道保持一致（44.1k/2ch PCM），文本取对应前缀。固定同一句合成文本。
 *
 * 判据：
 *   · 三档耗时接近        ⇒ 长度无关，1.1s 差异来自采样率/文本，不必限制参考音长度
 *   · 耗时随时长单调上升  ⇒ 参考音长度是真成本 ⇒ 多情绪参考音必须统一裁短
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8189';
const DIR = 'C:\\Users\\74689\\.agent\\work\\voice-len-test';
const ORIG = 'C:\\Users\\74689\\.agent\\models\\voices\\FlutterShy.wav';
const ORIG_TXT = 'C:\\Users\\74689\\.agent\\models\\voices\\FlutterShy.txt';

const CASES = [
  { name: '3.5s  (Short)', wav: path.join(DIR, 'Short.wav'), txt: path.join(DIR, 'Short.txt'), dur: 3.5 },
  { name: '8.0s  (Mid)  ', wav: path.join(DIR, 'Mid.wav'), txt: path.join(DIR, 'Mid.txt'), dur: 8.0 },
  { name: '15.86s (原文件)', wav: ORIG, txt: ORIG_TXT, dur: 15.86 },
];

const TEXT = '今天天气不错，我们一起出去散散步吧。';

async function speak(wav, txtPath) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'breeze-tts-2',
      input: TEXT,
      response_format: 'wav',
      voice_ref: wav,
      reference_text: fs.readFileSync(txtPath, 'utf8').trim(),
    }),
    signal: AbortSignal.timeout(180000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, bytes: -1, err: (await res.text().catch(() => '')).slice(0, 120) };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ms, bytes: buf.length };
}

const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
if (!h || h.status !== 'ok') {
  console.log(`❌ :8189 未就绪 ${JSON.stringify(h)}`);
  process.exit(1);
}
console.log(`✅ server 就绪\n（固定文本「${TEXT}」，只改参考音时长）\n`);

// 预热
await speak(ORIG, ORIG_TXT);

const ROUNDS = 3;
const results = [];
for (const c of CASES) {
  const runs = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await speak(c.wav, c.txt);
    runs.push(r);
    console.log(`  ${c.name}  #${i}  ${String(r.ms).padStart(6)} ms  ${r.bytes} B${r.err ? '  ERR:' + r.err : ''}`);
  }
  const ok = runs.filter((r) => r.bytes > 0);
  const med = ok.length ? [...ok].sort((a, b) => a.ms - b.ms)[Math.floor(ok.length / 2)].ms : 0;
  results.push({ ...c, med, bytesSet: [...new Set(ok.map((r) => r.bytes))] });
  console.log('');
}

console.log('=== 汇总（按参考音时长排序）===');
for (const r of results) {
  console.log(`  参考音 ${r.name}  ⇒  中位 ${String(r.med).padStart(5)} ms   输出字节 ${r.bytesSet.join('/')}`);
}

const [a, b, c] = results.map((r) => r.med);
const monotonic = a <= b + 150 && b <= c + 150;
const spread = Math.max(a, b, c) - Math.min(a, b, c);
console.log(`\n  跨度 ${spread} ms`);
console.log(`  趋势：${monotonic ? '随参考音变长而变慢（单调）' : '无明显单调关系'}`);
console.log(
  `\n  ${spread > 600 ? '⚠️ 参考音时长是显著成本 ⇒ 多情绪参考音必须统一裁到相近长度' : '✅ 参考音时长影响很小 ⇒ 可以自由放不同长度的情绪参考音'}`,
);
