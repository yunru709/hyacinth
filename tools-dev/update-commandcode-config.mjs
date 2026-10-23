/**
 * 更新 commandcode 的模型清单 + 把失效的 `:free` 通道改到付费档。
 *
 * 幂等：可重复执行；写盘后自检（JSON 可解析 + 首字节 7B + 关键字段落位）。
 * 依据：2026-10-23 裸调 GET /provider/v1/models 的 92 条权威清单。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT = path.join(os.homedir(), '.agent');
const PROVIDERS = path.join(AGENT, 'providers.json');
const CHANNELS = path.join(AGENT, 'model-channels.json');

const CAP_TEXT = {
  streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'],
};

/** commandcode 现在真实存在的模型（付费 minimax 不写 cost，免得编价格） */
const MODELS = [
  {
    id: 'minimax/minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash',
    provider: 'commandcode',
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    capabilities: { ...CAP_TEXT },
    status: 'available',
    reasoning: true,
    thinkingStyle: 'effort-required',
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    provider: 'commandcode',
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image'] },
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006 },
    status: 'available',
    reasoning: true,
  },
  {
    id: 'stealth/glyph-cluster:free',
    name: 'Glyph Cluster (free)',
    provider: 'commandcode',
    contextWindow: 256000,
    maxOutputTokens: 32768,
    capabilities: { ...CAP_TEXT },
    cost: { input: 0, output: 0, cacheRead: 0 },
    status: 'available',
    reasoning: true,
    thinkingStyle: 'effort-required',
  },
  {
    id: 'reflection/beam:free',
    name: 'Beam (free)',
    provider: 'commandcode',
    contextWindow: 1048576,
    maxOutputTokens: 32768,
    capabilities: { ...CAP_TEXT },
    cost: { input: 0, output: 0, cacheRead: 0 },
    status: 'available',
    reasoning: true,
    thinkingStyle: 'effort-required',
  },
  {
    id: 'poolside/laguna-s-2.1-free',
    name: 'Laguna S 2.1 (free)',
    provider: 'commandcode',
    contextWindow: 256000,
    maxOutputTokens: 32768,
    capabilities: { ...CAP_TEXT },
    cost: { input: 0, output: 0, cacheRead: 0 },
    status: 'available',
    reasoning: true,
    thinkingStyle: 'effort-required',
  },
];

function writeJson(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(file, text, 'utf8'); // utf8 无 BOM
}

// ── 1. providers.json ─────────────────────────────────────────────
const provRaw = fs.readFileSync(PROVIDERS, 'utf8');
const prov = JSON.parse(provRaw);
if (!prov.providers?.commandcode) throw new Error('providers.commandcode missing');
const beforeIds = (prov.providers.commandcode.models ?? []).map((m) => m.id);
prov.providers.commandcode.models = MODELS;
writeJson(PROVIDERS, prov);

// 自检
const provCheckBuf = fs.readFileSync(PROVIDERS);
const provCheck = JSON.parse(provCheckBuf.toString('utf8'));
const ccModels = provCheck.providers.commandcode.models;
console.log(`[providers.json] first byte = 0x${provCheckBuf[0].toString(16)}`);
console.log(`[providers.json] before(${beforeIds.length}): ${beforeIds.join(', ')}`);
console.log(`[providers.json] after (${ccModels.length}): ${ccModels.map((m) => m.id).join(', ')}`);
if (provCheckBuf[0] !== 0x7b) throw new Error('providers.json has BOM or wrong first byte');
if (ccModels.length !== MODELS.length) throw new Error('models count mismatch');
if (ccModels.some((m) => m.id.includes(':free') && m.id.startsWith('minimax/'))) throw new Error('dead minimax :free still present');

// ── 2. model-channels.json ───────────────────────────────────────
const chan = JSON.parse(fs.readFileSync(CHANNELS, 'utf8'));
const retarget = 'minimax/minimax-m3.1-flash';
const changes = [];
for (const [name, cfg] of Object.entries(chan.channels ?? {})) {
  if (cfg && typeof cfg === 'object' && cfg.model === 'minimax/minimax-m3.1-flash:free') {
    changes.push(`${name}: ${cfg.model} -> ${retarget}`);
    cfg.model = retarget;
  }
}
writeJson(CHANNELS, chan);

const chanCheckBuf = fs.readFileSync(CHANNELS);
const chanCheck = JSON.parse(chanCheckBuf.toString('utf8'));
console.log(`\n[model-channels.json] first byte = 0x${chanCheckBuf[0].toString(16)}`);
for (const c of changes) console.log(`  changed ${c}`);
if (changes.length === 0) console.log('  (no `:free` channel to retarget — already updated?)');
if (chanCheckBuf[0] !== 0x7b) throw new Error('model-channels.json has BOM or wrong first byte');
for (const [name, cfg] of Object.entries(chanCheck.channels ?? {})) {
  if (cfg?.model === 'minimax/minimax-m3.1-flash:free') throw new Error(`channel ${name} still points at dead id`);
  console.log(`  ${name.padEnd(12)} -> ${cfg?.provider}/${cfg?.model}${cfg?.thinking !== undefined ? ` (thinking:${JSON.stringify(cfg.thinking)})` : ''}`);
}
console.log('\nOK');
