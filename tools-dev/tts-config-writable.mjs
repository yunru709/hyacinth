/**
 * 真实配置中心的可写性探针 —— 这是 UI 切换引擎实际走的那条路。
 *
 * 为什么要单独验：`configCenter.set()` 对**不在 defaults schema 里**的路径会直接抛
 * 「does not structurally exist」。我新加的 voice.tts.* 如果只在 defaults.ts 里加了值、
 * 但 schema 类型/结构没对上，UI 点一下就会报错。
 * 前面几个探针用的都是假配置中心（Map），**验不到这一层**。
 *
 * 用法：node tools-dev/tts-config-writable.mjs
 * 注意：会临时把 voice.tts.engine 改成 breeze-tts-2 再改回原值（不落盘，只动内存）。
 */
const { RuntimeConfigCenter } = await import('../dist/runtime/config-center.js');
const { getDefaultConfig } = await import('../dist/runtime/defaults.js');
const { ConfigManager } = await import('../dist/setup/config.js');

const cm = new ConfigManager(process.cwd());
await cm.loadEnvKeys();
const persisted = await cm.load();
const cc = RuntimeConfigCenter.getInstance();
cc.initialize(getDefaultConfig(), cm);
cc.merge(persisted);

let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) fail++;
};

const original = cc.get('voice.tts.engine');
console.log(`原始值 voice.tts.engine = ${JSON.stringify(original)}`);

// 模拟 UI 三次点击：三个引擎各写一次
for (const kind of ['breeze-tts-2', 'online', 'cosyvoice3']) {
  try {
    cc.set('voice.tts.engine', kind);
    const back = cc.get('voice.tts.engine');
    check(back === kind, `set('${kind}') → get = ${JSON.stringify(back)}`);
  } catch (e) {
    check(false, `set('${kind}') 抛错：${e.message}`);
  }
}

// 模拟 WebUI 会写的其余键（防止"只有 engine 能写、其它一点就崩"）
const extra = [
  ['voice.tts.breeze.cliPath', 'F:\\TTSEngines\\audio-cpp\\audiocpp_cli.exe'],
  ['voice.tts.breeze.modelPath', 'F:\\TTSEngines\\dl\\breeze-tts-2-q8_0.gguf'],
  ['voice.tts.breeze.backend', 'cuda'],
  ['voice.tts.online.provider', 'breeze'],
  ['voice.tts.online.model', 'breeze-tts-2'],
  ['voice.tts.online.timeoutMs', 60000],
];
for (const [k, v] of extra) {
  try {
    cc.set(k, v);
    check(JSON.stringify(cc.get(k)) === JSON.stringify(v), `set('${k}') 可写`);
  } catch (e) {
    check(false, `set('${k}') 抛错：${e.message}`);
  }
}

// 写完之后引擎清单应能反映"breeze 已就绪"
const { listAvailableEngines } = await import('../dist/tts/index.js');
const list = listAvailableEngines({ get: (k) => cc.get(k) });
console.log('\n=== 填入真实路径后的引擎清单 ===');
for (const e of list) {
  console.log(`  ${e.active ? '●' : '○'} ${e.kind.padEnd(13)} ${e.ready ? 'READY   ' : 'NOTREADY'} ${e.detail}`);
}
const breeze = list.find((e) => e.kind === 'breeze-tts-2');
check(breeze?.ready === true, 'breeze-tts-2 填入真实路径后 = READY（说明 UI 选它真的能用）');

// 还原
try {
  cc.set('voice.tts.engine', original);
  console.log(`\n已还原 voice.tts.engine = ${JSON.stringify(cc.get('voice.tts.engine'))}（仅内存，未落盘）`);
} catch (e) {
  console.log(`还原失败（不影响，未落盘）：${e.message}`);
}

console.log(fail === 0 ? '\n✅ 配置可写性全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
