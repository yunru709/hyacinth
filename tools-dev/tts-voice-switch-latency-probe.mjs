/**
 * 实测：**切换不同的情绪参考音，会不会带来额外延迟？**
 *
 * 背景：改造后同一角色会有多份「不同情绪的参考音」，say 每句可能换一份。
 * 如果 server 对每个新的 voice_ref 都要重做一遍音频编码/特征提取，那"按情绪换参考音"
 * 就是每句复付一次成本 —— 这会直接决定这个设计值不值得做。
 *
 * 测法（固定文本，只换 voice_ref）：
 *   A 组：同一份参考音连续 4 次  → 基线（含 server 内部可能的缓存命中）
 *   B 组：两份参考音交替 4 次    → 观察每次切换是否多出固定开销
 *   C 组：不同文本 + 同一参考音  → 分离「文本变化」的影响，避免把文本成本误记到音色切换上
 *
 * 判据：
 *   · B 组均值 ≈ A 组均值  ⇒ 切换无额外成本（server 不做 per-ref 预处理，或成本可忽略）
 *   · B 组每次切换显著更慢 ⇒ 需要缓存/预热策略
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:8189';
const VOICES = path.join(os.homedir(), '.agent', 'models', 'voices');

const FLUTTER = {
  wav: path.join(VOICES, 'FlutterShy.wav'),
  txt: fs.readFileSync(path.join(VOICES, 'FlutterShy.txt'), 'utf8').trim(),
};
const ZHTEST = {
  wav: path.join(VOICES, 'zh-test.wav'),
  txt: fs.readFileSync(path.join(VOICES, 'zh-test.txt'), 'utf8').trim(),
};

const TEXT_A = '今天天气不错，我们一起出去散散步吧。';
const TEXT_B = '这件事情我有点不太确定，你能再说一遍吗。';

async function speak(text, ref, label) {
  const t0 = Date.now();
  const body = {
    model: 'breeze-tts-2',
    input: text,
    response_format: 'wav',
    voice_ref: ref.wav,
    reference_text: ref.txt,
  };
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160);
    console.log(`  ❌ ${label}  HTTP ${res.status} ${detail}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  ${label.padEnd(26)} ${String(ms).padStart(6)} ms   ${buf.length} B`);
  return { ms, bytes: buf.length };
}

function stats(arr) {
  const v = arr.filter(Boolean);
  if (!v.length) return 'n/a';
  const nums = v.map((x) => x.ms);
  const sorted = [...nums].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return `中位 ${median} ms / 均值 ${mean} ms（${nums.join(', ')}）`;
}

async function main() {
  // 健康检查
  const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json())
    .catch(() => null);
  if (!h || h.status !== 'ok') {
    console.log(`❌ :8189 未就绪（${JSON.stringify(h)}）—— 先确保 breeze 服务在跑`);
    process.exit(1);
  }
  console.log(`✅ server 就绪：${JSON.stringify(h)}\n`);

  // 预热一次（排除首次请求的冷路径）
  console.log('预热（不计入统计）');
  await speak(TEXT_A, FLUTTER, 'warmup');

  console.log('\n=== A 组：同一参考音 × 4（基线）===');
  const A = [];
  for (let i = 1; i <= 4; i++) A.push(await speak(TEXT_A, FLUTTER, `A${i} FlutterShy`));

  console.log('\n=== B 组：两份参考音交替 × 4（每次都在切换）===');
  const B = [];
  for (let i = 1; i <= 4; i++) {
    const useFlutter = i % 2 === 1;
    B.push(await speak(TEXT_A, useFlutter ? FLUTTER : ZHTEST, `B${i} ${useFlutter ? 'FlutterShy' : 'zh-test'}`));
  }

  console.log('\n=== C 组：同一参考音 + 换文本 × 3（分离文本影响）===');
  const C = [];
  const texts = [TEXT_A, TEXT_B, TEXT_A];
  for (let i = 1; i <= 3; i++) C.push(await speak(texts[i - 1], FLUTTER, `C${i} 文本${i === 2 ? 'B' : 'A'}`));

  console.log('\n=== 汇总 ===');
  console.log(`  A 同参考音  : ${stats(A)}`);
  console.log(`  B 交替切换  : ${stats(B)}`);
  console.log(`  C 同音换文本: ${stats(C)}`);

  const avg = (arr) => {
    const v = arr.filter(Boolean).map((x) => x.ms);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
  };
  const aAvg = avg(A);
  const bAvg = avg(B);
  const delta = bAvg - aAvg;
  const pct = aAvg ? Math.round((delta / aAvg) * 100) : 0;
  console.log(`\n  B - A = ${delta >= 0 ? '+' : ''}${delta} ms (${pct >= 0 ? '+' : ''}${pct}%)`);

  // 音频字节数是否随参考音变化 —— 若是，说明切换确实换掉了音色（不是静默忽略）
  const aBytes = new Set(A.filter(Boolean).map((x) => x.bytes));
  const bBytes = new Set(B.filter(Boolean).map((x) => x.bytes));
  console.log(`  A 组字节集合: ${[...aBytes].join(', ')}（同音色应只有 1 个值）`);
  console.log(`  B 组字节集合: ${[...bBytes].join(', ')}（切换音色应出现 ≥2 个值）`);
  console.log(
    `\n  结论：${Math.abs(pct) <= 15 ? '✅ 切换参考音没有明显额外开销' : '⚠️ 切换带来了可测量的额外开销，需要考虑缓存策略'}`,
  );
}

await main();
