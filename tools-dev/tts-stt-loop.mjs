#!/usr/bin/env node
/**
 * tts-stt-loop.mjs —— TTS→STT 闭环**诊断**（2026-10-25）
 *
 * 定位：这是诊断仪器，不是生产验收环节。
 *   目的：查清「TTS 在什么条件下会输出不可懂的声音」。
 *
 * 为什么必须这么测：
 *   孑遗实听「你刚刚说出来的声音在我听起来是一段毫无意义的声音」。
 *   而 wall / 音频字节数 / 帧数 / 时长**只能证明"生成了声音"，证明不了"说的是这句话"**
 *   —— 一个全程嘟囔的合成器同样能产出漂亮的时长数字。
 *   只有把音频转回文字、与原文比对，才能判定内容正确性。
 *
 * 用法：
 *   node tools-dev/tts-stt-loop.mjs "文本"                  # 默认音色（第一个）
 *   node tools-dev/tts-stt-loop.mjs "文本" zh-test          # 指定音色
 *   node tools-dev/tts-stt-loop.mjs "文本" zh-test --keep    # 保留转码中间文件
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

const TEXT =
  process.argv[2] ??
  '孑遗你好，今天我们在测试语音合成的稳定性问题，希望这一次能够顺利收尾。';
const VOICE = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
const KEEP = process.argv.includes('--keep');

const FFMPEG =
  'C:\\Python311\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe';
const MODEL_DIR = path.join(os.homedir(), '.agent', 'models', 'stt', 'sense-voice');
// 放 ~/.agent/work 而非 %TEMP%（火绒拦未知 exe 写 %TEMP%）
const OUT_DIR = path.join(os.homedir(), '.agent', 'work', 'stt-loop');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 1) 合成 ──────────────────────────────────────────────
const t0 = Date.now();
const body = VOICE ? { text: TEXT, voice: VOICE } : { text: TEXT };
const res = await fetch('http://127.0.0.1:3178/tts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`TTS 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const wall = (Date.now() - t0) / 1000;
const stamp = Date.now();
const wavPath = path.join(OUT_DIR, `tts-${stamp}.wav`);
fs.writeFileSync(wavPath, buf);

// ── 2) 转 16k 单声道 Float32（STT 输入约定）──────────────
const rawPath = path.join(OUT_DIR, `tts-${stamp}.f32`);
execFileSync(FFMPEG, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-i', wavPath,
  '-ar', '16000', '-ac', '1', '-f', 'f32le', rawPath,
]);
const raw = fs.readFileSync(rawPath);
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

// ── 3) SenseVoice 转写 ──────────────────────────────────
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OfflineRecognizer({
  // 配置形状照抄 src/stt/engines/sensevoice.ts（那里踩过三个坑并写了注释）
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
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples });
recognizer.decode(stream);
const heard = String(recognizer.getResult(stream).text ?? '').trim();

// ── 4) 比对（去标点后算字符级 LCS 命中率）────────────────
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
const got = norm(heard);
const hit = lcs(want, got);
const sim = want.length ? (hit / want.length) * 100 : 0;

console.log('─'.repeat(64));
console.log(`音色: ${VOICE || '（默认/第一个）'}`);
console.log(`原文 (${want.length} 字): ${TEXT}`);
console.log(`转写 (${got.length} 字): ${heard || '（空 — 没识别出任何文字）'}`);
console.log(`相似度: ${sim.toFixed(1)}%   命中 ${hit}/${want.length}`);
console.log(`wall=${wall.toFixed(2)}s  音频=${buf.length}B  ${(samples.length / 16000).toFixed(2)}s`);
console.log(`wav: ${wavPath}`);
console.log('─'.repeat(64));

if (!KEEP) {
  try { fs.unlinkSync(rawPath); } catch { /* 清理失败不影响结论 */ }
}
