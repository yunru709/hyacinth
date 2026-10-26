// TTS emotion 探针：验证 emotion → instruct2 是否真正生效，并做 STT 内容验收。
//
// ⚠️ 为什么不能只用时长判断：
//   语气变化会让时长/韵律变，但**复读/拖长**同样会让时长变（而且更容易）。
//   2026-10-25 就吃过这个亏：wall=13.6s 看着"说得完整"，实际内容崩坏（STT 相似度 0%）。
//   ⇒ 时长差异只能证明"结果变了"，STT 相似度才证明"说的是这句话"。
//
// ⚠️ 为什么不用 PowerShell 的 Invoke-WebRequest：
//   它默认按 ASCII/Latin1 发 body ⇒ 中文变 "?" ⇒ wetext 归一化后为空
//   ⇒ "tts 未产出音频"（2026-10-26 假故障，浪费了一轮排查）。Node fetch 走 UTF-8，无此坑。
//
// 用法：node tools-dev/tts-emotion-probe.mjs [text] [voice]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const PORT = 3178;
const TEXT = process.argv[2] || '今天天气不错，适合出门走走。';
const VOICE = process.argv[3] || 'FlutterShy';
const OUT_DIR = path.join(os.homedir(), '.agent', 'work', 'emotion-probe');
const MODEL_DIR = path.join(os.homedir(), '.agent', 'models', 'stt', 'sense-voice');
const FFMPEG =
  'C:\\Python311\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe';

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 1) 合成 ────────────────────────────────────────────
async function synth(label, emotion) {
  const body = { text: TEXT, voice: VOICE };
  if (emotion) body.emotion = emotion;
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} → ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(OUT_DIR, `${label}.wav`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, wall: ms / 1000 };
}

// ── 2) STT 转写（配置形状照抄 src/stt/engines/sensevoice.ts）──────
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OfflineRecognizer({
  modelConfig: {
    senseVoice: {
      model: path.join(MODEL_DIR, 'model.int8.onnx'),
      useInverseTextNormalization: 1,
    },
    tokens: path.join(MODEL_DIR, 'tokens.txt'),
    numThreads: 2,
    debug: false,
    provider: 'cpu',
  },
});

function transcribe(wavPath) {
  const f32 = wavPath.replace(/\.wav$/, '.f32');
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', wavPath, '-ar', '16000', '-ac', '1', '-f', 'f32le', f32,
  ]);
  const raw = fs.readFileSync(f32);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  recognizer.decode(stream);
  return {
    text: String(recognizer.getResult(stream).text ?? '').trim(),
    dur: samples.length / 16000,
  };
}

// ── 3) 字符级 LCS 相似度 ───────────────────────────────
const norm = (s) => s.replace(/[\s，。！？、,.!?；;：:"'「」（）()]/g, '');
function lcs(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

const want = norm(TEXT);
console.log(`文本: ${TEXT}\n音色: ${VOICE}\n`);

const cases = [
  ['no-emotion', null],
  ['温rou', '温柔'],
  ['激动', '激动'],
];

const rows = [];
for (const [label, emotion] of cases) {
  const got = await synth(label, emotion);
  if (!got) continue;
  const stt = transcribe(got.file);
  const hit = lcs(want, norm(stt.text));
  const sim = want.length ? (hit / want.length) * 100 : 0;
  rows.push({ label, emotion, sim, hit, ...got, heard: stt.text, dur: stt.dur });
}

console.log('─'.repeat(70));
for (const r of rows) {
  console.log(
    `${r.label.padEnd(12)} 时長${r.dur.toFixed(2)}s  wall=${r.wall.toFixed(2)}s  ` +
    `相似度${r.sim.toFixed(1)}% (${r.hit}/${want.length})`
  );
  console.log(`             转写: ${r.heard || '（空）'}`);
}
console.log('─'.repeat(70));

// ── 判据 ───────────────────────────────────────────────
const ok = rows.filter((r) => r.sim >= 80);
if (ok.length === rows.length) {
  console.log('✅ 全部内容可懂（≥80%）；语气差异见时长列');
} else {
  console.log(`⚠️ ${rows.length - ok.length}/${rows.length} 条内容不可懂 ⇒ 语气指令可能让模型跑偏`);
}
