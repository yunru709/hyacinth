/**
 * 实测：BreezeTTS 2 的「笑声」等非语言标记到底怎么表达？
 *
 * 背景（2026-10-26 孑遗指出）：不同 TTS 引擎背后的模型参数需求不同，
 * breeze 号称支持"笑声"这类特殊能力，say 工具应该能把它用出来。
 *
 * 但 audio.cpp 的 model_specs/breeze_tts.json 里 **没有** 叫 laughter/laugh 的参数，
 * 只有 `instruct`（自由文本生成指令）和 `text_chunk_mode: tag_aware`（"保留行内标签"的分块模式）。
 * 官方文档站点访问不通（api.breeze.blue 401 / HF 超时），所以只能实测。
 *
 * 三个候选表达方式：
 *   A 基线        纯文本
 *   B 行内标签    [laughter] / [laugh] / （笑）等，配合 text_chunk_mode=tag_aware
 *   C instruct    用生成指令描述"笑着说"
 *
 * 判据（我听不到音频，只能看可测量信号）：
 *   · 输出时长显著变长（>0.4s）  ⇒ 真的多合成了笑声
 *   · 标签被原样念出来            ⇒ 反而更差（和 cosyvoice 的 instruct2 一个毛病）
 *   · 时长与基线一致              ⇒ 标签被忽略，这条路不通
 *
 * 额外用 STT 转写来判定"标签是否被念出来"——这是比时长更硬的证据。
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8189';
const REF = {
  wav: 'C:\\Users\\74689\\.agent\\models\\voices\\breeze_reference_audio.wav',
  txt: 'C:\\Users\\74689\\.agent\\models\\voices\\breeze_reference_audio.txt',
};

const BASE_TEXT = '今天天气真好啊，我们出去走走吧。';

const CASES = [
  { id: 'A 基线', text: BASE_TEXT, mode: 'default' },
  { id: 'B [laughter]', text: `${BASE_TEXT}[laughter]`, mode: 'tag_aware' },
  { id: 'C [laugh]', text: `${BASE_TEXT}[laugh]`, mode: 'tag_aware' },
  { id: 'D （笑）', text: `${BASE_TEXT}（笑）`, mode: 'tag_aware' },
  { id: 'E <laugh>', text: `${BASE_TEXT}<laugh>`, mode: 'tag_aware' },
];

function wavDuration(buf) {
  if (buf.length < 44 || buf.subarray(0, 4).toString() !== 'RIFF') return 0;
  // 找 fmt 与 data
  let pos = 12, sr = 0, ch = 0, bits = 0, dataSz = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.subarray(pos, pos + 4).toString();
    const sz = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      ch = buf.readUInt16LE(pos + 10);
      sr = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      dataSz = sz;
      break;
    }
    pos += 8 + sz + (sz & 1);
  }
  if (!sr || !ch || !bits) return 0;
  return dataSz / (sr * ch * (bits / 8));
}

async function speak(text, mode) {
  const t0 = Date.now();
  const body = {
    model: 'breeze-tts-2',
    input: text,
    response_format: 'wav',
    voice_ref: REF.wav,
    reference_text: fs.readFileSync(REF.txt, 'utf8').trim(),
    options: { text_chunk_mode: mode, seed: 42, temperature: 0.7 },
  };
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    return { ms, ok: false, err: (await res.text().catch(() => '')).slice(0, 200) };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ms, ok: true, bytes: buf.length, dur: wavDuration(buf), buf };
}

const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
if (!h || h.status !== 'ok') {
  console.log(`❌ :8189 未就绪 ${JSON.stringify(h)}`);
  process.exit(1);
}
console.log('✅ server 就绪，开始实测「笑声」表达方式');
console.log(`   参考音：breeze_reference_audio（中文）  固定 seed=42 / temp=0.7\n`);

// 预热
await speak(BASE_TEXT, 'default');

const outDir = 'C:\\Users\\74689\\.agent\\work\\laugh-test';
fs.mkdirSync(outDir, { recursive: true });

const rows = [];
for (const c of CASES) {
  const r = await speak(c.text, c.mode);
  if (!r.ok) {
    console.log(`  ${c.id.padEnd(16)} ❌ ${r.err}`);
    continue;
  }
  const fname = path.join(outDir, `${c.id.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.wav`);
  fs.writeFileSync(fname, r.buf);
  rows.push({ ...c, ...r, fname });
  console.log(
    `  ${c.id.padEnd(16)} ${String(r.ms).padStart(6)} ms   ${String(r.bytes).padStart(7)} B   音频 ${r.dur.toFixed(2)}s`,
  );
}

const base = rows.find((r) => r.id.startsWith('A'));
console.log('\n=== 与基线对比 ===');
for (const r of rows) {
  if (!base || r.id === base.id) continue;
  const dDur = r.dur - base.dur;
  const dBytes = r.bytes - base.bytes;
  const flag =
    Math.abs(dDur) < 0.15
      ? '≈ 无变化（标签被忽略）'
      : dDur > 0
        ? `+${dDur.toFixed(2)}s（可能多合成了笑声）`
        : `${dDur.toFixed(2)}s（更短）`;
  console.log(`  ${r.id.padEnd(16)} 时长${dDur >= 0 ? '+' : ''}${dDur.toFixed(2)}s  字节${dBytes >= 0 ? '+' : ''}${dBytes}   ${flag}`);
}

console.log(`\n音频已落盘：${outDir}`);
console.log('下一步（人工/STT 判定）：听 D/（笑）那份，或看转写里有没有把「laughter」念出来。');
