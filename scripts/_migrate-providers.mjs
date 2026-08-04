import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PROVIDERS } from '../dist/provider/config.js';

const home = os.homedir();
const provPath = path.join(home, '.agent', 'providers.json');
const bakPath = path.join(home, '.agent', 'providers.json.bak');
const catalogPath = path.join(home, '.agent', 'models-catalog.json');
const catalogBak = path.join(home, '.agent', 'models-catalog.json.bak');

// 1) 备份旧 providers.json
if (fs.existsSync(provPath)) {
  fs.copyFileSync(provPath, bakPath);
  console.log(`备份旧配置 → ${bakPath}`);
}

// 2) 从 DEFAULT_PROVIDERS 生成新配置（含 models + 修正 defaultModel）
const newConfig = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS));
fs.writeFileSync(provPath, JSON.stringify(newConfig, null, 2), 'utf-8');
console.log(`已写入新 providers.json（${Object.keys(newConfig.providers).length} 个 provider，均带 models）`);

// 校验：每个 provider 的 defaultModel 必须在自身 models 内
let allOk = true;
for (const [id, meta] of Object.entries(newConfig.providers)) {
  const def = meta.defaultModel;
  const inModels = (meta.models ?? []).some((m) => m.id === def);
  const hasDefault = (meta.models ?? []).some((m) => m.id === '__default__');
  if (hasDefault) {
    console.log(`⚠ ${id} 仍含 __default__ 占位！`);
    allOk = false;
  }
  if (!inModels) {
    console.log(`⚠ ${id} defaultModel="${def}" 不在 models 内！`);
    allOk = false;
  }
}
console.log(allOk ? '✅ 全部 provider: defaultModel ∈ models，无 __default__ 残留' : '❌ 存在不一致');

// 3) 备份 models-catalog.json（loader 已不再读取，保留备份可回退）
if (fs.existsSync(catalogPath)) {
  fs.copyFileSync(catalogPath, catalogBak);
  console.log(`已备份 models-catalog.json → ${catalogBak}（新 loader 不再读取该文件）`);
}
