/**
 * 默认值可见性探针：真实 config.json 里 `voice` 只有 `say`（没有 `tts`），
 * 而我在 defaults.ts 里新加了 `voice.tts.*`。必须确认 load + deepMerge 之后
 * `configCenter.get('voice.tts.engine')` 真能看到默认值 —— 否则 UI 下拉拿不到
 * active，用户切了也没处落脚。
 *
 * 初始化顺序**照抄 tui.ts:676-681**（这是唯一权威）：
 *   cm.loadEnvKeys() → cfg = await cm.load() → initialize(getDefaultConfig(), cm) → merge(cfg)
 *
 * 用法：node tools-dev/tts-defaults-visible.mjs
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

const keys = [
  'voice.tts.engine',
  'voice.tts.breeze.cliPath',
  'voice.tts.breeze.modelPath',
  'voice.tts.breeze.backend',
  'voice.tts.breeze.device',
  'voice.tts.online.provider',
  'voice.tts.online.baseUrl',
  'voice.tts.online.model',
  'voice.tts.online.language',
  'voice.tts.online.format',
];

// 仓库默认值里**故意为空**的键：它们是用户机器上的路径（不能硬编码进仓库），
// 空 = 该引擎未安装，UI 显示「未就绪」。判据是"键存在"而不是"值非空"。
const USER_SUPPLIED = new Set(['voice.tts.breeze.cliPath', 'voice.tts.breeze.modelPath']);

let fail = 0;
console.log('=== 真实配置中心（load + merge 后）里 voice.tts.* 的可见性 ===');
for (const k of keys) {
  let v;
  let err = null;
  try {
    v = cc.get(k);
  } catch (e) {
    err = e;
  }
  const shown = err ? `THROW: ${err.message}` : JSON.stringify(v);
  const visible = !err && v !== undefined;
  const expectEmpty = USER_SUPPLIED.has(k);
  const ok = visible && (expectEmpty || v !== '');
  if (!ok) fail++;
  const note = expectEmpty && v === '' ? '（用户待填，默认空 = 未安装）' : '';
  console.log(`${ok ? '✅' : '❌'} ${k.padEnd(34)} = ${shown}${note}`);
}

// 引擎清单在「真实配置」下是否正确反映默认 active
const { listAvailableEngines } = await import('../dist/tts/index.js');
const reader = { get: (k) => cc.get(k) };
const list = listAvailableEngines(reader);
console.log('\n=== 真实配置下的引擎清单 ===');
for (const e of list) {
  console.log(`  ${e.active ? '●' : '○'} ${e.kind.padEnd(13)} ${e.ready ? 'READY   ' : 'NOTREADY'} ${e.detail}`);
}
const active = list.filter((e) => e.active);
if (active.length !== 1) {
  console.log(`❌ active 数量 = ${active.length}（应为 1）`);
  fail++;
} else {
  console.log(`\n✅ active = ${active[0].kind}`);
}

console.log(fail === 0 ? '\n✅ 默认值全部可见' : `\n❌ ${fail} 项有问题`);
process.exit(fail === 0 ? 0 : 1);
