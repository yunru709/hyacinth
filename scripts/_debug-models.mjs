import { getModelCatalogLoader } from '../dist/provider/model-catalog-loader.js';
import { getModelInfo } from '../dist/provider/catalog.js';
import { PROVIDER_MODELS } from '../dist/setup/model-defaults.js';

const loader = getModelCatalogLoader();
const all = loader.getAll();
const byProv = {};
for (const m of all) {
  (byProv[m.provider] ??= []).push(m.id + ' (' + m.name + ')');
}
console.log('=== models-catalog.json 原始内容（每个 provider 的 id） ===');
for (const [p, ids] of Object.entries(byProv)) console.log(p + ':', ids.join(', '));

console.log('');
console.log('=== provider 层查询 ===');
const probes = [
  ['anthropic', 'claude-sonnet-4-20250514'],
  ['openai', 'gpt-4o'],
  ['deepseek', 'deepseek-v4-flash'],
  ['gemini', 'gemini-2.5-pro'],
];
for (const [p, id] of probes) {
  const info = getModelInfo(p, id);
  console.log(p + '/' + id + ':', info ? '查到 maxTokens=' + info.maxOutputTokens + ' ctx=' + info.contextWindow : '查不到(undefined)');
}

console.log('');
console.log('=== setup 展示 vs provider 默认模型 (providers.json) ===');
const provMap = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  deepseek: 'deepseek-v4-flash',
  gemini: 'gemini-2.5-flash',
};
for (const [p, def] of Object.entries(provMap)) {
  const setupModels = (PROVIDER_MODELS[p] || []).map((m) => m.id);
  const inSetup = setupModels.includes(def);
  const info = getModelInfo(p, def);
  console.log(
    p.padEnd(10),
    'providers.json默认=' + def.padEnd(24),
    '| setup列表=' + (setupModels.length ? setupModels.join(',') : '(空)'),
    '| 默认在setup? ' + (inSetup ? 'YES' : 'NO'),
    '| provider层可查? ' + (info ? 'YES' : 'NO'),
  );
}
