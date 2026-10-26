// 通用 WAV 转写工具：拿磁盘上任意 WAV → SenseVoice 转写 → 可选与原句算 LCS 相似度。
//
// 为什么单独抽出来：tts-stt-loop.mjs 是「合成+转写」一体，用于本地引擎；
// 在线引擎（breeze/openai）返回的 wav 已经落盘，只需要转写这一步。
// 两者共用同一套 STT 配置，避免口径漂移（配置形状照抄 src/stt/engines/sensevoice.ts）。
//
// 用法：node tools-dev/wav-stt.mjs <wav路径> [原句]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const WAV = process.argv[2];
const WANT = process.argv[3] || '';
if (!WAV || !fs.existsSync(WAV)) {
  console.error('用法: node tools-dev/wav-stt.mjs <wav路径> [原句]');
  process.exit(2);
}

const MODEL_DIR = path.join(os.homedir(), '.agent', 'models', 'stt', 'sense-voice');
const FFMPEG =
  'C:\\Python311\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe';

// 1) 任意采样率/声道 → 16k 单声道 f32
const f32 = WAV.replace(/\.wav$/i, '') + '.stt.f32';
execFileSync(FFMPEG, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-i', WAV, '-ar', '16000', '-ac', '1', '-f', 'f32le', f32,
]);
const raw = fs.readFileSync(f32);
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

// 2) SenseVoice
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
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples });
recognizer.decode(stream);
const heard = String(recognizer.getResult(stream).text ?? '').trim();

// 3) 可选比对
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

const dur = samples.length / 16000;
console.log('─'.repeat(64));
console.log(`文件: ${path.basename(WAV)}  (${dur.toFixed(2)}s @16k)`);
if (WANT) {
  const w = norm(WANT), g = norm(heard);
  const hit = lcs(w, g);
  const sim = w.length ? (hit / w.length) * 100 : 0;
  console.log(`原文 (${w.length} 字): ${WANT}`);
  console.log(`转写 (${g.length} 字): ${heard || '（空）'}`);
  console.log(`相似度: ${sim.toFixed(1)}%   命中 ${hit}/${w.length}`);
} else {
  console.log(`转写: ${heard || '（空）'}`);
}
console.log('─'.repeat(64));
