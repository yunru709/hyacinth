// 诊断：模拟 registerConfigChannels 的完整链路，看 QQ 插件是否被注册
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfgPath = path.join(os.homedir(), '.agent', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log('[1] config.json 里的 channels.qq =');
console.log(JSON.stringify(cfg.channels?.qq ?? null, null, 2));

// 检查 dist 产物存在
const distIdx = path.join(process.cwd(), 'dist', 'channels', 'plugins', 'qq', 'index.js');
console.log('\n[2] dist 产物存在 =', fs.existsSync(distIdx));

// 真正 import 插件，看 channelPlugin 是否导出
const mod = await import('../dist/channels/plugins/qq/index.js');
console.log('\n[3] 导出键 =', Object.keys(mod).join(', '));
console.log('[4] channelPlugin.configKey =', mod.channelPlugin?.configKey);
console.log('[5] channelPlugin.autoRegister 是函数 =', typeof mod.channelPlugin?.autoRegister === 'function');

// 用假 channelManager 走一遍 autoRegister
const registered = [];
const fakeManager = {
  register: (handler, config) => {
    registered.push({ id: handler.id, config });
    console.log('[6] register() 被调用: id =', handler.id);
  },
};
const info = [];
await mod.channelPlugin.autoRegister(fakeManager, cfg.channels?.qq, info);
console.log('\n[7] 注册数量 =', registered.length);
console.log('[8] channelsInfo =', JSON.stringify(info));

if (registered.length === 0) {
  console.log('\n❌ 未被注册 —— autoRegister 内部某个判断把它挡了');
  process.exit(1);
}
console.log('\n✅ 注册链路正常，说明问题在 start() 或 discoverPlugins');
