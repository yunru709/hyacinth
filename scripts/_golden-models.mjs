/**
 * 黄金主测试：全量对比 setup 展示模型列表 vs provider 层实际可查模型。
 * 遍历所有 provider：
 *   1) 每个 provider 的 defaultModel 必须出现在 setup 展示列表（PROVIDER_MODELS）
 *   2) setup 列表里的每个模型，provider 层 getModelInfo 必须可查
 *   3) setup 列表不得含 __default__ 占位
 * 成功标准：零差异。
 */
import { getModelCatalogLoader } from '../dist/provider/model-catalog-loader.js';
import { getModelInfo } from '../dist/provider/catalog.js';
import { PROVIDER_MODELS } from '../dist/setup/model-defaults.js';
import { DEFAULT_PROVIDERS } from '../dist/provider/config.js';

let total = 0;
let diff = 0;
console.log('=== 黄金主测试：setup 展示 vs provider 层全量对比 ===\n');

for (const [pid, meta] of Object.entries(DEFAULT_PROVIDERS.providers)) {
  const def = meta.defaultModel;
  const setupModels = (PROVIDER_MODELS[pid] || []).map((m) => m.id);
  const problems = [];

  // 1) defaultModel 必须在 setup 列表
  if (!setupModels.includes(def)) {
    problems.push(`defaultModel '${def}' 不在 setup 列表`);
  }

  // 2) setup 列表无 __default__
  if (setupModels.includes('__default__')) {
    problems.push('setup 列表含 __default__ 占位');
  }

  // 3) setup 列表每个模型 provider 层可查
  for (const id of setupModels) {
    const info = getModelInfo(pid, id);
    if (!info) {
      problems.push(`setup 模型 '${id}' provider 层查不到`);
    } else if (!(info.contextWindow > 0 && info.maxOutputTokens > 0)) {
      problems.push(`setup 模型 '${id}' 能力信息不完整 (ctx=${info.contextWindow}, max=${info.maxOutputTokens})`);
    }
  }

  // 4) provider 层默认模型 = defaultModel 可查
  const defInfo = getModelInfo(pid, def);
  if (!defInfo) {
    problems.push(`defaultModel '${def}' provider 层查不到`);
  }

  total++;
  const ok = problems.length === 0;
  if (!ok) diff++;
  console.log(
    `${ok ? '✅' : '❌'} ${pid.padEnd(12)} default=${def.padEnd(28)} setup模型数=${String(setupModels.length).padStart(3)}` +
      (ok ? '' : `\n    问题: ${problems.join('; ')}`),
  );
}

console.log(`\n=== 结果: ${total} 个 provider, ${diff} 个有差异 ===`);
process.exit(diff === 0 ? 0 : 1);
