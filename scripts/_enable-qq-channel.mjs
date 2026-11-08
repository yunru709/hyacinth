// 启用 QQ 渠道（写 ~/.agent/config.json 的 channels.qq）
// 为什么直接改文件而不走 update_config：channels 是**启动期**由 ConfigManager 读取，
// 不在 runtime configCenter 管辖范围（已确认 config-center.ts 无 channels 键）。
// 因此正确路径 = 改 config.json + 重启。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfgPath = path.join(os.homedir(), '.agent', 'config.json');
const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

if (!raw.channels) raw.channels = {};
raw.channels.qq = {
  enabled: true,
  httpUrl: 'http://127.0.0.1:3000',
  wsUrl: 'ws://127.0.0.1:3001',
  accessToken: '',
  // 只服务号主本人 —— 孑遗 2026-11-08 明确「目前先只和我」
  allowFrom: [746896396],
  groupAllowFrom: [],
  requireMention: true,
  selfId: 3994097359,
  tuiSync: false,
  textChunkLimit: 4000,
  httpTimeoutMs: 15000,
  reconnectIntervalMs: 3000,
};

fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');

// 读回自检（PS 纪律：写后必读回）
const check = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log('channels.qq =', JSON.stringify(check.channels.qq, null, 2));
console.log('allowFrom 长度 =', check.channels.qq.allowFrom.length);
console.log('enabled =', check.channels.qq.enabled);
