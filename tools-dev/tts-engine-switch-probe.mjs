/**
 * 「say 接哪个引擎」端到端机制探针（不需要起服务）。
 *
 * 验三件事：
 *  ① listAvailableEngines：三引擎各自 capabilities/ready/active
 *  ② **热切换**：改配置后 getTtsEngine 是否真的换实例（这是功能命脉；
 *     若插件持旧实例，会出现"界面切了、声音没变"的假绿）
 *  ③ createTtsDomain 的 engines()/setEngine() 契约行为（含非法 kind 拒绝）
 *
 * 用法：node tools-dev/tts-engine-switch-probe.mjs
 */
const { listAvailableEngines, getTtsEngine, resetTtsEngine } = await import('../dist/tts/index.js');
const { createTtsDomain } = await import('../dist/ui-protocol/domains/tts.js');

// 可写的假配置中心：模拟 configCenter.set()
const store = new Map([
  ['voice.tts.engine', 'cosyvoice3'],
  ['voice.tts.breeze.cliPath', 'F:\\TTSEngines\\audio-cpp\\audiocpp_cli.exe'],
  ['voice.tts.breeze.modelPath', 'F:\\TTSEngines\\dl\\breeze-tts-2-q8_0.gguf'],
  ['voice.tts.breeze.backend', 'cuda'],
  ['voice.tts.online.provider', 'breeze'],
  ['voice.tts.online.baseUrl', 'https://api.breeze.blue'],
]);
const reader = {
  get(k) {
    return store.get(k);
  },
};

let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) fail++;
};

// ── ① 清单 ───────────────────────────────────────────────
console.log('=== ① listAvailableEngines ===');
const list = listAvailableEngines(reader);
check(list.length === 3, `3 个引擎（实际 ${list.length}）`);
check(list.filter((e) => e.active).length === 1, 'active 恰好 1 个');
for (const e of list) {
  console.log(`   ${e.active ? '●' : '○'} ${e.kind.padEnd(13)} ${e.ready ? 'READY   ' : 'NOTREADY'} ` +
    `emotion=${e.capabilities.emotion} speed=${e.capabilities.speed}`);
}

// ── ② 热切换（命脉）─────────────────────────────────────
console.log('\n=== ② getTtsEngine 热切换 ===');
resetTtsEngine();
const e1 = getTtsEngine(reader);
check(e1.id === 'cosyvoice3', `初始 = ${e1.id}（期望 cosyvoice3）`);

store.set('voice.tts.engine', 'breeze-tts-2');
const e2 = getTtsEngine(reader);
check(e2.id === 'breeze-tts-2', `改配置后 = ${e2.id}（期望 breeze-tts-2）`);
check(e1 !== e2, '实例确实被重建（不是同一个对象）');

store.set('voice.tts.engine', 'online');
store.set('voice.tts.online.provider', 'breeze');
const e3 = getTtsEngine(reader);
check(e3.id === 'online-breeze', `再切 = ${e3.id}（期望 online-breeze）`);

// 同配置重复取用应复用同一实例（不能每次重建）
const e3b = getTtsEngine(reader);
check(e3 === e3b, '同配置重复取用复用同一实例（未退化成每次重建）');

store.set('voice.tts.engine', 'cosyvoice3');
const e4 = getTtsEngine(reader);
check(e4.id === 'cosyvoice3', `切回 = ${e4.id}（期望 cosyvoice3）`);

// ── ③ 契约域 ─────────────────────────────────────────────
console.log('\n=== ③ createTtsDomain 的 engines()/setEngine() ===');
const domain = createTtsDomain({
  getService: () => null, // 故意不给 cosyvoice 服务：引擎选择不应被它挡住
  listEngines: () => listAvailableEngines(reader),
  getEngineKind: () => String(store.get('voice.tts.engine') || 'cosyvoice3'),
  setEngineKind: (k) => store.set('voice.tts.engine', k),
});

const res = domain.engines();
check(res.engines.length === 3 && res.active === 'cosyvoice3', `engines() active=${res.active}`);

const setRes = domain.setEngine({ kind: 'breeze-tts-2' });
check(setRes.ok === true && setRes.active === 'breeze-tts-2', `setEngine → active=${setRes.active}`);
check(store.get('voice.tts.engine') === 'breeze-tts-2', '配置已写入 voice.tts.engine');

let rejected = false;
try {
  domain.setEngine({ kind: 'not-a-real-engine' });
} catch (err) {
  rejected = /未知引擎/.test(String(err.message));
}
check(rejected, '非法 kind 被拒绝（附可选项提示）');

let missingArg = false;
try {
  domain.setEngine({});
} catch (err) {
  missingArg = /requires "kind"/.test(String(err.message));
}
check(missingArg, '缺参数被拒绝');

resetTtsEngine();
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
