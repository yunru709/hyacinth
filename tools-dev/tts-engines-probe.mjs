/**
 * 引擎清单探针：确认 listAvailableEngines() 在真实配置下能返回三引擎 + 正确的 active/ready。
 * 用法：node tools-dev/tts-engines-probe.mjs
 */
import { listAvailableEngines } from '../dist/tts/index.js';

// 用真实 config.json 里的值（这里手工给一份，等价于 configCenter.get 的返回）
const conf = new Map([
  ['voice.tts.engine', process.argv[2] || 'cosyvoice3'],
  ['voice.tts.breeze.cliPath', 'F:\\TTSEngines\\audio-cpp\\audiocpp_cli.exe'],
  ['voice.tts.breeze.modelPath', 'F:\\TTSEngines\\dl\\breeze-tts-2-q8_0.gguf'],
  ['voice.tts.breeze.backend', 'cuda'],
  ['voice.tts.online.provider', 'breeze'],
  ['voice.tts.online.baseUrl', 'https://api.breeze.blue'],
  ['voice.tts.online.model', 'breeze-tts-2'],
  ['voice.tts.online.voice', 'voc_9k38qhkc6qrm'],
]);
const reader = { get: (k) => conf.get(k) };

const list = listAvailableEngines(reader);
console.log(`=== listAvailableEngines（engine=${conf.get('voice.tts.engine')}）===`);
for (const e of list) {
  console.log(
    [
      e.active ? '●' : '○',
      e.kind.padEnd(13),
      e.kindType.padEnd(7),
      (e.ready ? 'READY  ' : 'NOTREADY'),
      `cap={voice:${e.capabilities.voice},speed:${e.capabilities.speed},emotion:${e.capabilities.emotion}}`,
      e.label,
    ].join(' '),
  );
  if (!e.ready) console.log(`    ↳ ${e.detail}`);
}
const active = list.filter((e) => e.active);
console.log(`\nactive 数量 = ${active.length}（必须恰好 1）: ${active.map((e) => e.kind).join(',') || '无'}`);
if (active.length !== 1) {
  console.error('❌ active 标记异常');
  process.exit(1);
}
