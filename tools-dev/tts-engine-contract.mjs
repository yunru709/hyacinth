// 新 TTS 架构的契约验证：直接调 dist 里的工厂，不经过 say 工具/插件链路。
//
// 为什么单独验：架构改动（契约 + 工厂 + 三实现）最容易出的错是"编译过、运行时不通"。
// 这里绕开插件，直接验证 TtsEngine 契约 + online 引擎的 breeze 请求是否真的对。
//
// 用法：node tools-dev/tts-engine-contract.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../dist/tts/index.js');
const { createTtsEngine } = mod;

const OUT_DIR = path.join(os.homedir(), '.agent', 'work', 'engine-contract');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TEXT = '今天天气不错，适合出门走走。';

function reader(obj) {
  return { get: (k) => obj[k] };
}

// ── 1) 契约形状：三个引擎都要满足 ──────────────────────────
console.log('=== 契约检查 ===');
const BREEZE_CONF = {
  'voice.tts.engine': 'breeze-tts-2',
  'voice.tts.breeze.cliPath': 'F:\\TTSEngines\\audio-cpp\\audiocpp_cli.exe',
  'voice.tts.breeze.modelPath': 'F:\\TTSEngines\\dl\\breeze-tts-2-q8_0.gguf',
  'voice.tts.breeze.backend': 'cuda',
  'voice.tts.breeze.device': 0,
};
for (const [name, conf] of [
  ['cosyvoice3', { 'voice.tts.engine': 'cosyvoice3' }],
  ['breeze-tts-2', BREEZE_CONF],
  ['online', { 'voice.tts.engine': 'online', 'voice.tts.online.provider': 'breeze' }],
]) {
  const e = createTtsEngine(reader(conf));
  const cap = e.capabilities();
  const voices = e.voices();
  const st = e.status?.();
  console.log(
    `${name.padEnd(11)} id=${String(e.id).padEnd(16)} kind=${String(e.kind).padEnd(6)} ` +
    `cap={voice:${cap.voice},speed:${cap.speed},emotion:${cap.emotion}} voices=${voices.length} ` +
    `ready=${st?.ready} ${st?.detail ? '| ' + String(st.detail).slice(0, 46) : ''}`
  );
}

// ── 2) breeze-tts-2 本地引擎实合成（GGUF + audio.cpp）──────────
// 注意：8GB 显存只能容一份 3.7GB 权重 ⇒ 跑这段前先停掉 cosyvoice 服务。
console.log('\n=== breeze-tts-2 本地实合成 ===');
const local = createTtsEngine(reader(BREEZE_CONF));
console.log('id:', local.id, '| kind:', local.kind, '| cap:', JSON.stringify(local.capabilities()), '| status:', local.status?.().detail);

for (const [label, emotion] of [['plain', undefined], ['warm', '用温柔的语气说这句话']]) {
  const t0 = Date.now();
  try {
    const buf = await local.synthesize(TEXT, { emotion });
    const ms = Date.now() - t0;
    const file = path.join(OUT_DIR, `breeze2-${label}.wav`);
    fs.writeFileSync(file, buf);
    const isWav = buf.subarray(0, 4).toString() === 'RIFF';
    const rate = isWav ? buf.readUInt32LE(24) : 0;
    const ch = isWav ? buf.readUInt16LE(22) : 0;
    const bits = isWav ? buf.readUInt16LE(34) : 0;
    const dur = isWav ? (buf.length - 44) / (rate * ch * (bits / 8)) : NaN;
    console.log(`${label.padEnd(6)} ok ${buf.length}B  wav=${isWav} ${rate}Hz/${ch}ch/${bits}bit  dur=${dur.toFixed(2)}s  wall=${(ms / 1000).toFixed(2)}s`);
    console.log(`       → ${file}`);
  } catch (err) {
    console.log(`${label.padEnd(6)} FAILED: ${String(err.message || err).slice(0, 240)}`);
  }
}

console.log('\n下一步：node tools-dev/wav-stt.mjs <上面任一 wav> "' + TEXT + '" 验内容');
