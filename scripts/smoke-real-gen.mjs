// 凭证迁移后验证：apiKeyEnv 模式走真实 API
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GenerateMediaTool } from '../dist/tools/generate-media.js';

// 模拟 cli.ts 的 loadEnvKeys：从 ~/.agent/.env 加载到 process.env
const envPath = path.join(os.homedir(), '.agent', '.env');
try {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
} catch { /* ignore */ }

// 确认 key 已从环境变量读到（不回显值）
if (!process.env.ARK_API_KEY) {
  console.error('FAIL: ARK_API_KEY 未从 .env 加载');
  process.exit(1);
}
console.log(`OK: ARK_API_KEY 已加载（长度 ${process.env.ARK_API_KEY.length}）`);

const tool = new GenerateMediaTool(process.cwd());
const result = await tool.execute({
  modality: 'image',
  prompt: '一只戴宇航头盔的橘猫，坐在月球表面看地球升起，电影感，暖色光',
  negative_prompt: '模糊，低画质',
  size: '2K',
});
console.log('=== RESULT ===');

console.log(result);
