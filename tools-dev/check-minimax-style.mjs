/**
 * 验证：运行时 getModelInfo 对 commandcode / minimax 的解析结果。
 * 只读，不发请求。
 */
import { getModelInfo } from '../dist/provider/catalog.js';
import { resolveThinkingStyle, buildThinkingParams } from '../dist/provider/thinking-style.js';
import { getProviderConfigLoader } from '../dist/provider/config.js';

const probes = [
  ['commandcode', 'minimax/minimax-m3.1-flash'],
  ['commandcode', 'minimax/minimax-m3.1-flash:free'],
  ['commandcode', 'deepseek/deepseek-v4.1-flash'],
];

for (const [prov, model] of probes) {
  const info = getModelInfo(prov, model);
  console.log(`\n--- ${prov} / ${model}`);
  if (!info) {
    console.log('  modelInfo: <NOT FOUND>');
    continue;
  }
  console.log(`  capabilities.thinking = ${info.capabilities.thinking}`);
  console.log(`  reasoning             = ${(info).reasoning}`);
  console.log(`  thinkingStyle(model)  = ${info.thinkingStyle ?? '<undefined>'}`);
  console.log(`  contextWindow/maxOut  = ${info.contextWindow}/${info.maxOutputTokens}`);
}

const provCfg = getProviderConfigLoader().getProvider('commandcode');
console.log(`\n--- provider-level: commandcode`);
console.log(`  thinkingStyle(provider) = ${provCfg?.thinkingStyle ?? '<undefined>'}`);
console.log(`  defaultModel            = ${provCfg?.defaultModel}`);

console.log(`\n=== 生效 style & 实际 wire 字段 ===`);
for (const [prov, model] of probes) {
  const info = getModelInfo(prov, model);
  const style = resolveThinkingStyle(provCfg?.thinkingStyle, info?.thinkingStyle);
  const on = buildThinkingParams(style, true, 'high');
  const off = buildThinkingParams(style, false, 'high');
  console.log(`  ${model}`);
  console.log(`    style=${style}`);
  console.log(`    thinking:true  -> ${JSON.stringify(on)}`);
  console.log(`    thinking:false -> ${JSON.stringify(off)}`);
}
