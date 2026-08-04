import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MINIMAL_FALLBACK —— 硬编码自 src/provider/model-catalog-loader.ts（真实 id，权威基准）
const MINIMAL_FALLBACK = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000 },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000 },
  { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 32000 },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384 },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', contextWindow: 1047576, maxOutputTokens: 32768 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', contextWindow: 1000000, maxOutputTokens: 393216 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', contextWindow: 1000000, maxOutputTokens: 393216 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1048576, maxOutputTokens: 65536 },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick', provider: 'groq', contextWindow: 131072, maxOutputTokens: 16384 },
  { id: 'grok-4', name: 'Grok 4', provider: 'xai', contextWindow: 1000000, maxOutputTokens: 128000 },
  { id: 'mistral-large-latest', name: 'Mistral Large', provider: 'mistral', contextWindow: 131072, maxOutputTokens: 131072 },
  { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'openrouter', contextWindow: 200000, maxOutputTokens: 4096 },
  { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', provider: 'moonshot', contextWindow: 128000, maxOutputTokens: 4096 },
  { id: 'qwen3-vl-plus', name: 'Qwen3 VL Plus', provider: 'qwen', contextWindow: 131072, maxOutputTokens: 8192 },
  { id: 'glm-4.6v', name: 'GLM-4.6V', provider: 'zhipu', contextWindow: 128000, maxOutputTokens: 4096 },
  { id: 'MiniMax-M3', name: 'MiniMax M3', provider: 'minimax', contextWindow: 1000000, maxOutputTokens: 4096 },
  { id: 'mimo-v2.5', name: 'MiMo V2.5', provider: 'mimo', contextWindow: 131072, maxOutputTokens: 8192 },
];

const catalog = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agent', 'models-catalog.json'), 'utf-8'));
const providers = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agent', 'providers.json'), 'utf-8'));

const fbByProv = {};
for (const f of MINIMAL_FALLBACK) (fbByProv[f.provider] ??= []).push(f);

// 用户目录中非 __default__ 的自定义模型
const customByProv = {};
for (const e of catalog.models) {
  if (e.id === '__default__') continue;
  (customByProv[e.provider] ??= []).push(e);
}

const allProv = new Set([...Object.keys(providers.providers), ...Object.keys(fbByProv)]);

console.log('=== 最终合并清单（每个 provider 的 models） ===');
const result = {};
for (const p of [...allProv].sort()) {
  const meta = providers.providers[p];
  const def = meta?.defaultModel;
  const fb = fbByProv[p] ?? [];
  const custom = customByProv[p] ?? [];

  // 合并：内置(排除与自定义重复的) + 自定义
  const merged = [];
  const seen = new Set();
  for (const m of [...fb, ...custom]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens });
  }

  // 检查 defaultModel 是否在清单中
  const defInMerged = def ? merged.some((m) => m.id === def) : false;
  result[p] = merged;
  console.log(`◆ ${p.padEnd(12)} default=${(def ?? '无').padEnd(24)} | 清单(${merged.length}):`);
  for (const m of merged) {
    const mark = m.id === def ? ' ← default' : '';
    console.log(`    - ${m.id} (${m.name}) ctx=${m.contextWindow} maxOut=${m.maxOutputTokens}${mark}`);
  }
  if (!defInMerged && def) console.log(`    ⚠ defaultModel "${def}" 不在清单中！`);
  console.log('');
}

fs.writeFileSync('scripts/_merged-models.json', JSON.stringify(result, null, 2));
console.log('已写入 scripts/_merged-models.json');
