/**
 * 实测：`[laughter]` 标签到底依赖不依赖 `text_chunk_mode=tag_aware`？
 *
 * 为什么必须测：之前的 laugh-tag 探针**所有标签用例都用了 tag_aware**，
 * 所以无法区分「标签本身被模型识别」与「只有 tag_aware 分块才保留标签」。
 * 这直接决定 say 的设计：
 *   · 若 default 模式也生效 ⇒ 只要文本里写标签就行，不必动参数
 *   · 若只有 tag_aware 生效   ⇒ 必须在检测到标签时自动切 tag_aware（否则用户写了没用）
 *
 * 判据（对比基线 A＝无标签同模式）：
 *   · 时长显著变长且 STT 转写里没出现 "laughter" ⇒ 标签被当作非语言标记合成
 *   · 时长与基线一致                              ⇒ 标签被当普通文字（或被切分丢弃）
 *
 * 每种组合跑 2 次（第一次可能有 warm 缓存抖动）。
 */

import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8189';
const REF = {
  wav: 'C:\\Users\\74689\\.agent\\models\\voices\\breeze_reference_audio.wav',
  txt: 'C:\\Users\\74689\\.agent\\models\\voices\\breeze_reference_audio.txt',
};
const BASE_TEXT = '今天天气真好啊，我们出去走走吧。';

const CASES = [
  { id: 'A1 无标签+default', text: BASE_TEXT, mode: 'default' },
  { id: 'A2 无标签+tag_aware', text: BASE_TEXT, mode: 'tag_aware' },
  { id: 'B1 [laughter]+default', text: `${BASE_TEXT}[laughter]`, mode: 'default' },
  { id: 'B2 [laughter]+tag_aware', text: `${BASE_TEXT}[laughter]`, mode: 'tag_aware' },
  { id: 'C1 <laugh>+default', text: `${BASE_TEXT}<laugh>`, mode: 'default' },
  { id: 'C2 <laugh>+tag_aware', text: `${BASE_TEXT}<laugh>`, mode: 'tag_aware' },
];

function wavDuration(buf) {
  if (buf.length < 44 || buf.subarray(0, 4).toString() !== 'RIFF') return 0;
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
  if (!res.ok) return { ok: false, ms, err: (await res.text().catch(() => '')).slice(0, 160) };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, ms, bytes: buf.length, dur: wavDuration(buf), buf };
}

const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
if (!h || h.status !== 'ok') {
  console.log(`❌ :8189 未就绪 ${JSON.stringify(h)}`);
  process.exit(1);
}
console.log('✅ server 就绪，测「标签是否依赖 tag_aware」\n');

const outDir = 'C:\\Users\\74689\\.agent\\work\\laugh-mode-test';
fs.mkdirSync(outDir, { recursive: true });

// 预热
await speak(BASE_TEXT, 'default');

const rows = [];
for (const c of CASES) {
  const runs = [];
  for (let i = 1; i <= 2; i++) runs.push(await speak(c.text, c.mode));
  const ok = runs.filter((r) => r.ok);
  if (!ok.length) {
    console.log(`  ${c.id.padEnd(24)} ❌ ${runs[0].err}`);
    continue;
  }
  const med = [...ok].sort((a, b) => a.dur - b.dur)[Math.floor(ok.length / 2)];
  const fname = `${c.id.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.wav`;
  fs.writeFileSync(`${outDir}\\${fname}`, med.buf);
  rows.push({ ...c, dur: med.dur, bytes: med.bytes, ms: med.ms, fname });
  console.log(`  ${c.id.padEnd(24)} ${String(med.ms).padStart(6)} ms   音频 ${med.dur.toFixed(2)}s   ${med.bytes} B`);
}

const base = rows.find((r) => r.id.startsWith('A1'));
console.log('\n=== 相对基线（A1 无标签+default）===');
for (const r of rows) {
  if (!base || r.id === base.id) continue;
  const d = r.dur - base.dur;
  console.log(`  ${r.id.padEnd(24)} 时长${d >= 0 ? '+' : ''}${d.toFixed(2)}s`);
}

console.log(`\n音频落盘：${outDir}`);
console.log('下一步：对每个标签用例跑 STT，确认多出来的时长不是"念出了单词"。');
