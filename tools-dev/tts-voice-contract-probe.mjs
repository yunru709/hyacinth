/**
 * 契约验证：breeze-tts-2 的 voice 参数是否真的生效。
 *
 * 走的是 say 的真实链路（真实 config.json → getTtsEngine → synthesize），
 * 不是直接敲 CLI —— 因为这次要验的正是**适配器**有没有把参数传对。
 *
 * 判据：
 *   1. voices() 能列出 FlutterShy / zh-test（wav+txt 成对的）
 *   2. voice='FlutterShy' 与 voice='default' 输出**不同**（同文本同 seed=0，排除随机性）
 *   3. voice='不存在的音色' → 抛错（而不是静默回退默认音色）
 *
 * 为什么第 3 条重要：静默回退正是上一版的 bug —— 用户以为换了音色，其实没换。
 */
import fs from 'node:fs';
import path from 'node:path';

const { RuntimeConfigCenter } = await import('../dist/runtime/config-center.js');
const { getDefaultConfig } = await import('../dist/runtime/defaults.js');
const { ConfigManager } = await import('../dist/setup/config.js');
const { getTtsEngine, resetTtsEngine } = await import('../dist/tts/index.js');

const OUT = path.join(process.env.USERPROFILE || process.cwd(), '.agent', 'work', 'voice-contract');
fs.mkdirSync(OUT, { recursive: true });

const cm = new ConfigManager(process.cwd());
await cm.loadEnvKeys();
const persisted = await cm.load();
const cc = RuntimeConfigCenter.getInstance();
cc.initialize(getDefaultConfig(), cm);
cc.merge(persisted);

const reader = { get: (k) => cc.get(k) };

// 固定 seed 让两次合成可比（spec default=0，这里显式写一遍以免默认值将来变）
cc.set('voice.tts.breeze.requestOptions', { seed: '0' });
cc.set('voice.tts.engine', 'breeze-tts-2');
resetTtsEngine();

const engine = getTtsEngine(reader);
console.log(`引擎: id=${engine.id} kind=${engine.kind}`);
console.log(`配置 voicesDir = ${JSON.stringify(cc.get('voice.tts.breeze.voicesDir'))}（空 = 回退 <models.root>/voices）\n`);

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) fail++; };

// ── 1. 音色列表 ────────────────────────────────────────────────
const vs = engine.voices();
console.log('音色列表:', vs.map((v) => v.id).join(', '));
check(vs.some((v) => v.id === 'FlutterShy'), '列表含 FlutterShy');
check(vs.some((v) => v.id === 'zh-test'), '列表含 zh-test');

// ── 2. 两种音色输出必须不同 ─────────────────────────────────────
const TEXT = '今天天气不错，我们出去走走吧。';
const t0 = Date.now();
const wavDefault = await engine.synthesize(TEXT, { voice: 'default' });
console.log(`\n[default]      ${wavDefault.length} B  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
fs.writeFileSync(path.join(OUT, 'default.wav'), wavDefault);

const t1 = Date.now();
const wavFlutter = await engine.synthesize(TEXT, { voice: 'FlutterShy' });
console.log(`[FlutterShy]   ${wavFlutter.length} B  用时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
fs.writeFileSync(path.join(OUT, 'FlutterShy.wav'), wavFlutter);

check(wavDefault.length !== wavFlutter.length, `两种音色输出不同（${wavDefault.length} vs ${wavFlutter.length}）`);

// ── 3. 不存在的音色必须抛错，不能静默回退 ─────────────────────────
let threw = false;
let errMsg = '';
try {
  await engine.synthesize(TEXT, { voice: 'nonexistent-voice-xyz' });
} catch (e) {
  threw = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
check(threw, `不存在的音色抛错（而不是静默用默认音色）`);
if (threw) console.log(`   错误信息: ${errMsg}`);

console.log(`\n产物目录: ${OUT}`);
process.exit(fail ? 1 : 0);
