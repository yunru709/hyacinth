/**
 * 契约验证：breeze-tts-2 走常驻 server（HTTP）这条路是否真的通、真的快。
 *
 * 走的是 say 的真实链路：真实 config.json → getTtsEngine → synthesize
 * （不是直接 curl，因为要验的正是**适配器**有没有把 HTTP 分支接对）。
 *
 * 判据：
 *   1. serverUrl 配了 ⇒ 走 HTTP，能出有效 WAV
 *   2. 比 CLI 快（这是做这件事的全部理由）
 *   3. voice 克隆在 HTTP 路径下也生效（= 与 CLI 输出字节一致）
 *   4. 不存在的音色仍然抛错（不因换传输方式就丢了这个保护）
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { RuntimeConfigCenter } = await import('../dist/runtime/config-center.js');
const { getDefaultConfig } = await import('../dist/runtime/defaults.js');
const { ConfigManager } = await import('../dist/setup/config.js');
const { getTtsEngine, resetTtsEngine } = await import('../dist/tts/index.js');

const OUT = path.join(process.env.USERPROFILE || process.cwd(), '.agent', 'work', 'server-contract');
fs.mkdirSync(OUT, { recursive: true });

const cm = new ConfigManager(process.cwd());
await cm.loadEnvKeys();
const persisted = await cm.load();
const cc = RuntimeConfigCenter.getInstance();
cc.initialize(getDefaultConfig(), cm);
cc.merge(persisted);

const reader = { get: (k) => cc.get(k) };
cc.set('voice.tts.engine', 'breeze-tts-2');
cc.set('voice.tts.breeze.serverUrl', 'http://127.0.0.1:8189');
cc.set('voice.tts.breeze.requestOptions', {}); // 清掉 seed，避免上一轮探针残留干扰
resetTtsEngine();

const engine = getTtsEngine(reader);
console.log(`引擎: ${engine.id}  传输: HTTP (${cc.get('voice.tts.breeze.serverUrl')})\n`);

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) fail++; };
const TEXT = '今天天气不错，我们出去走走吧。';

// ── 1. 基本合成 ────────────────────────────────────────────────
let t = performance.now();
const wavDefault = await engine.synthesize(TEXT, { voice: 'default' });
const msDefault = performance.now() - t;
console.log(`[default]     ${wavDefault.length} B   ${(msDefault / 1000).toFixed(2)}s`);
fs.writeFileSync(path.join(OUT, 'default.wav'), wavDefault);
check(wavDefault.length > 1000 && wavDefault.subarray(0, 4).toString() === 'RIFF', 'HTTP 返回有效 WAV');
// 判据来自实测：CLI 是 9.7s，server 应显著更低。给足余量取 6s。
check(msDefault < 6000, `比 CLI 快（${(msDefault / 1000).toFixed(2)}s < 6s；CLI 实测 9.7s）`);

// ── 2. 第二次（应更快或持平：证明常驻确实省掉了加载）──────────────
t = performance.now();
const wav2 = await engine.synthesize(TEXT, { voice: 'default' });
const ms2 = performance.now() - t;
console.log(`[default #2]  ${wav2.length} B   ${(ms2 / 1000).toFixed(2)}s`);
check(ms2 < 6000, `重复调用仍快（${(ms2 / 1000).toFixed(2)}s）`);

// ── 3. voice 克隆在 HTTP 路径下生效 ─────────────────────────────
t = performance.now();
const wavFlutter = await engine.synthesize(TEXT, { voice: 'FlutterShy' });
const msFlutter = performance.now() - t;
console.log(`[FlutterShy]  ${wavFlutter.length} B   ${(msFlutter / 1000).toFixed(2)}s`);
fs.writeFileSync(path.join(OUT, 'FlutterShy.wav'), wavFlutter);
check(wavFlutter.length !== wavDefault.length, `克隆与默认音色不同（${wavDefault.length} vs ${wavFlutter.length}）`);
// CLI 下克隆实测 145964 B；HTTP 应给同一份参考音 ⇒ 期望接近
check(wavFlutter.length === 145964, `与 CLI 克隆字节一致（期望 145964，实得 ${wavFlutter.length}）`);

// ── 4. emotion → instructions ──────────────────────────────────
t = performance.now();
const wavWarm = await engine.synthesize(TEXT, { voice: 'default', emotion: '用温柔的语气说这句话' });
const msWarm = performance.now() - t;
console.log(`[warm]        ${wavWarm.length} B   ${(msWarm / 1000).toFixed(2)}s`);
fs.writeFileSync(path.join(OUT, 'warm.wav'), wavWarm);
check(wavWarm.length !== wavDefault.length, `emotion 生效（${wavDefault.length} vs ${wavWarm.length}）`);

// ── 5. 不存在的音色必须抛错 ─────────────────────────────────────
let threw = false;
let errMsg = '';
try {
  await engine.synthesize(TEXT, { voice: 'nonexistent-voice-xyz' });
} catch (e) {
  threw = true;
  errMsg = e instanceof Error ? e.message : String(e);
}
check(threw, 'HTTP 路径下不存在的音色仍抛错');
if (threw) console.log(`   ${errMsg}`);

// ── 6. server 挂掉时的报错要能指导用户 ────────────────────────────
cc.set('voice.tts.breeze.serverUrl', 'http://127.0.0.1:59999'); // 确定没在听
resetTtsEngine();
const dead = getTtsEngine(reader);
let deadThrew = false;
let deadMsg = '';
try {
  await dead.synthesize(TEXT, { voice: 'default' });
} catch (e) {
  deadThrew = true;
  deadMsg = e instanceof Error ? e.message : String(e);
}
check(deadThrew, 'server 不可达时抛错');
if (deadThrew) console.log(`   ${deadMsg.slice(0, 180)}`);

console.log(`\n产物: ${OUT}`);
process.exit(fail ? 1 : 0);
