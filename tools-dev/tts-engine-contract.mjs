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

// ── 1) 契约形状：两个引擎都要满足 ──────────────────────────
console.log('=== 契约检查 ===');
for (const [name, conf] of [
  ['cosyvoice3', { 'voice.tts.engine': 'cosyvoice3' }],
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

// ── 2) online 引擎实合成（breeze，走真网络）──────────────────
console.log('\n=== online 引擎实合成（breeze）===');
const onConf = {
  get(k) {
    const m = {
      'voice.tts.engine': 'online',
      'voice.tts.online.provider': 'breeze',
      'voice.tts.online.baseUrl': 'https://api.breeze.blue',
      'voice.tts.online.model': 'breeze-tts-2',
      'voice.tts.online.voice': 'voc_9k38qhkc6qrm',
      'voice.tts.online.language': 'zh',
      'voice.tts.online.format': 'wav_24000',
      // apiKey 走环境变量兜底（BREEZE_API_KEY），不落盘
    };
    return m[k];
  },
};
const online = createTtsEngine(onConf);
console.log('id:', online.id, '| kind:', online.kind, '| cap:', JSON.stringify(online.capabilities()));

for (const [label, emotion] of [['plain', undefined], ['warm', '用温柔的语气说这句话']]) {
  const t0 = Date.now();
  try {
    const buf = await online.synthesize(TEXT, { emotion });
    const ms = Date.now() - t0;
    const file = path.join(OUT_DIR, `breeze-${label}.wav`);
    fs.writeFileSync(file, buf);
    const isWav = buf.subarray(0, 4).toString() === 'RIFF';
    const dur = isWav ? (buf.length - 44) / (24000 * 2) : NaN;
    console.log(
      `${label.padEnd(6)} ok ${buf.length}B  wav=${isWav}  dur=${dur.toFixed(2)}s  wall=${(ms / 1000).toFixed(2)}s`
    );
    console.log(`       → ${file}`);
  } catch (err) {
    console.log(`${label.padEnd(6)} FAILED: ${String(err.message || err).slice(0, 200)}`);
  }
}

console.log('\n下一步：node tools-dev/wav-stt.mjs <上面任一 wav> "' + TEXT + '" 验内容');
