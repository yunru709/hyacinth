/**
 * 端到端集成探针：真实 config.json → getTtsEngine → 合成 → 落盘。
 *
 * 这是「切换后 say 的声音真的变了」的最终证据链。前面几个探针分别验了
 * 清单 / 假配置热切换 / configCenter 可写，但**没有一条**把"真实配置中心"
 * 和"真实引擎合成"接起来。say 工具走的就是这条路：
 *   say → plugin.engine.synthesize → getTtsEngine(configCenter) → 具体实现
 *
 * 用法：node tools-dev/tts-say-path-probe.mjs [kind]
 *   缺省跑 breeze-tts-2（约 9s）；传 cosyvoice3 / online 亦可（需各自就绪）
 * 注意：会临时改 voice.tts.engine，跑完还原（只动内存，不落盘）。
 */
import fs from 'node:fs';
import path from 'node:path';

const { RuntimeConfigCenter } = await import('../dist/runtime/config-center.js');
const { getDefaultConfig } = await import('../dist/runtime/defaults.js');
const { ConfigManager } = await import('../dist/setup/config.js');
const { getTtsEngine, resetTtsEngine } = await import('../dist/tts/index.js');

const OUT_DIR = path.join(process.env.USERPROFILE || process.cwd(), '.agent', 'work', 'engine-contract');
fs.mkdirSync(OUT_DIR, { recursive: true });

const cm = new ConfigManager(process.cwd());
await cm.loadEnvKeys();
const persisted = await cm.load();
const cc = RuntimeConfigCenter.getInstance();
cc.initialize(getDefaultConfig(), cm);
cc.merge(persisted);

const reader = { get: (k) => cc.get(k) };
const original = cc.get('voice.tts.engine');
const target = process.argv[2] || 'breeze-tts-2';

console.log(`原始 voice.tts.engine = ${JSON.stringify(original)}`);
console.log(`本次切到 = ${target}`);

let fail = 0;
try {
  cc.set('voice.tts.engine', target);
  resetTtsEngine();

  // ⚠️ 这一行等价于插件里那句 `getTtsEngine({ get: getConfig })`
  const engine = getTtsEngine(reader);
  console.log(`工厂给出引擎: id=${engine.id} kind=${engine.kind}`);
  console.log(`capabilities: ${JSON.stringify(engine.capabilities())}`);
  console.log(`status: ${engine.status?.().detail ?? '(无)'}`);

  const st = engine.status?.();
  if (st && st.ready === false) {
    console.error(`\n❌ 该引擎未就绪，无法合成：${st.detail}`);
    fail = 1;
  } else {
    const TEXT = '今天天气不错，适合出门走走。';
    const t0 = Date.now();
    const buf = await engine.synthesize(TEXT, { emotion: '用温柔的语气说这句话' });
    const ms = Date.now() - t0;
    const file = path.join(OUT_DIR, `saypath-${target}.wav`);
    fs.writeFileSync(file, buf);
    const isWav = buf.subarray(0, 4).toString() === 'RIFF';
    const rate = isWav ? buf.readUInt32LE(24) : 0;
    const ch = isWav ? buf.readUInt16LE(22) : 0;
    const bits = isWav ? buf.readUInt16LE(34) : 0;
    const dur = isWav && rate ? (buf.length - 44) / (rate * ch * (bits / 8)) : NaN;
    console.log(`\n✅ 合成成功 ${buf.length}B  wav=${isWav} ${rate}Hz/${ch}ch/${bits}bit dur=${dur.toFixed(2)}s wall=${(ms / 1000).toFixed(2)}s`);
    console.log(`   → ${file}`);
    console.log(`\n下一步 STT 验收：node tools-dev/wav-stt.mjs "${file}" "${TEXT}"`);
  }
} catch (e) {
  console.error(`\n❌ 失败：${e.message}`);
  fail = 1;
} finally {
  try {
    cc.set('voice.tts.engine', original);
    resetTtsEngine();
    console.log(`\n已还原 voice.tts.engine = ${JSON.stringify(cc.get('voice.tts.engine'))}（仅内存，未落盘）`);
  } catch (e) {
    console.log(`还原失败（不影响，未落盘）：${e.message}`);
  }
}

process.exit(fail);
