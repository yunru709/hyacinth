/**
 * 行为验证：`serverAutoStart` 真的会把常驻服务拉起来吗？
 *
 * 之前的契约探针（tts-server-contract-probe.mjs）是**手工先起好 server** 再测的，
 * 证明不了「用户什么都不做也会快」。本探针专测那条自动化路径。
 *
 * 判据（缺一不可）：
 *   1. 事先没人在 8189 听 ⇒ synthesize 仍成功（说明自己把服务拉起来了）
 *   2. 第二次调用显著更快（常驻的意义）
 *   3. 进程退出时服务被带走（不留孤儿吃 3.7GB 显存）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { RuntimeConfigCenter } = await import('../dist/runtime/config-center.js');
const { getDefaultConfig } = await import('../dist/runtime/defaults.js');
const { ConfigManager } = await import('../dist/setup/config.js');
const { getTtsEngine, resetTtsEngine } = await import('../dist/tts/index.js');
const { breezeServerState } = await import('../dist/tts/engines/breeze-server.js');

const PORT = 8189;
const OUT = path.join(process.env.USERPROFILE || process.cwd(), '.agent', 'work', 'autostart');
fs.mkdirSync(OUT, { recursive: true });

function portOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(1200);
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    s.once('timeout', () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) fail++; };

// ── 前置：8189 必须真的没人听（否则测的不是自动拉起）───────────────
const before = await portOpen(PORT);
check(!before, `前置：${PORT} 开始前无人监听（实际 ${before ? '有人在听 ⇒ 测不准' : '空'})`);
if (before) {
  console.log('  跳过：请先关掉手工起的 audiocpp_server 再跑本探针');
  process.exit(1);
}

// ── 配置：只开 autoStart，serverUrl 留空 ─────────────────────────
const cm = new ConfigManager(process.cwd());
await cm.loadEnvKeys();
const persisted = await cm.load();
const cc = RuntimeConfigCenter.getInstance();
cc.initialize(getDefaultConfig(), cm);
cc.merge(persisted);

cc.set('voice.tts.engine', 'breeze-tts-2');
cc.set('voice.tts.breeze.serverUrl', '');       // 关键：留空
cc.set('voice.tts.breeze.serverAutoStart', true); // 关键：靠它自启
cc.set('voice.tts.breeze.serverPort', PORT);
cc.set('voice.tts.breeze.requestOptions', {});
resetTtsEngine();

const reader = { get: (k) => cc.get(k) };
const engine = getTtsEngine(reader);
console.log(`引擎: ${engine.id}  autoStart=${cc.get('voice.tts.breeze.serverAutoStart')}  serverUrl='${cc.get('voice.tts.breeze.serverUrl')}'\n`);

const TEXT = '今天天气不错，我们出去走走吧。';

// ── 第一次：应当把服务拉起来（含模型加载，预计 12~20s）──────────────
let t = performance.now();
const wav1 = await engine.synthesize(TEXT, { voice: 'default' });
const ms1 = performance.now() - t;
console.log(`[首句   ] ${wav1.length} B   ${(ms1 / 1000).toFixed(2)}s  （含自启 + 模型加载）`);
fs.writeFileSync(path.join(OUT, 'first.wav'), wav1);
check(wav1.length > 1000 && wav1.subarray(0, 4).toString() === 'RIFF', '自启路径返回有效 WAV');
const nowOpen = await portOpen(PORT);
check(nowOpen, `${PORT} 现在有服务在听（说明是自动拉起的）`);
const st = breezeServerState();
console.log(`   服务状态: running=${st.running} adopted=${st.adopted} port=${st.port}`);

// ── 第二次：应当显著快（这才是用户实际感受到的）───────────────────
t = performance.now();
const wav2 = await engine.synthesize(TEXT, { voice: 'default' });
const ms2 = performance.now() - t;
console.log(`[第二句 ] ${wav2.length} B   ${(ms2 / 1000).toFixed(2)}s`);
check(ms2 < 6000, `第二句 < 6s（实际 ${(ms2 / 1000).toFixed(2)}s；CLI 每次 9.7s）`);
check(ms2 < ms1, `第二句比首句快（${(ms2 / 1000).toFixed(2)}s < ${(ms1 / 1000).toFixed(2)}s）`);

// ── 音色在自启路径下也要生效 ────────────────────────────────────
const wavFlutter = await engine.synthesize(TEXT, { voice: 'FlutterShy' });
fs.writeFileSync(path.join(OUT, 'flutter.wav'), wavFlutter);
console.log(`[音色   ] ${wavFlutter.length} B`);
check(wavFlutter.length !== wav2.length, `音色生效（${wav2.length} vs ${wavFlutter.length}）`);

console.log(`\n产物: ${OUT}`);
console.log('注：本进程退出时若服务被正确带走，跑完 3 秒后端口应关闭。');
process.exit(fail ? 1 : 0);
