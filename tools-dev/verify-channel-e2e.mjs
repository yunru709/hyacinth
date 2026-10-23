/**
 * 端到端：dist 的 provider 层实际发一次 commandcode/minimax 请求，
 * 走 compression 通道的 thinking:false 路径 —— 验证不再发 `reasoning_effort:'off'`（那会 400）。
 *
 * 这是"配置对不对"的最终判据：不是看配置文本，是看 provider 真发出去什么、上游回什么。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProviderConfigLoader } from '../dist/provider/config.js';
import { createCommandCodeProvider } from '../dist/provider/compatible.js';
import { applyChannelThinking } from '../dist/provider/model-channel-registry.js';
import { getModelInfo } from '../dist/provider/catalog.js';

function loadKey() {
  const txt = fs.readFileSync(path.join(os.homedir(), '.agent', '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*COMMANDCODE_API_KEY\s*=\s*(.+)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('no key');
}

getProviderConfigLoader(process.cwd());

const MODEL = 'minimax/minimax-m3.1-flash';
const info = getModelInfo('commandcode', MODEL);
console.log(`modelInfo.thinkingStyle = ${info?.thinkingStyle}  capabilities.thinking = ${info?.capabilities?.thinking}`);

async function run(label, channelThinking) {
  const prov = createCommandCodeProvider({ model: MODEL, apiKey: loadKey() });
  applyChannelThinking(prov, channelThinking);

  let text = '';
  let thinking = '';
  let err = null;
  const t0 = Date.now();
  try {
    // ⚠️ content 必须是 **block 数组**（框架 Message 契约），传裸字符串会让
    // convertMessages 里 block.type 全 undefined ⇒ 产出无效消息 ⇒ 上游 400
    // "Too small: expected array to have >=1 items"。别改回字符串。
    for await (const ev of prov.createStream([
      { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] },
    ])) {
      if (ev.type === 'TEXT') text += ev.content;
      else if (ev.type === 'THINKING') thinking += ev.content;
      else if (ev.type === 'ERROR') err = ev.error ?? ev.message ?? JSON.stringify(ev);
    }
  } catch (e) {
    err = `${e?.message ?? e}${e?.status ? ` (status=${e.status})` : ''}`;
  }
  const ms = Date.now() - t0;
  console.log(`\n### ${label}  (channel thinking = ${JSON.stringify(channelThinking)})`);
  console.log(`  ${err ? 'ERROR: ' + err : `OK in ${ms}ms`}`);
  console.log(`  text: ${JSON.stringify(text.slice(0, 80))}`);
  console.log(`  thinking chars: ${thinking.length}${thinking ? ' :: ' + JSON.stringify(thinking.slice(0, 100)) : ''}`);
}

// compression / orchestrator / narration 的配置就是 thinking:false
await run('compression 通道（thinking:false）', false);
// sub-agent 通道未声明 thinking ⇒ applyChannelThinking 不动，provider 默认 false
await run('sub-agent 通道（未声明 ⇒ 默认）', undefined);
