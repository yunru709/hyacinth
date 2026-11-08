// 诊断：用 dist 产物走完整 registerConfigChannels 流程（含 discoverPlugins）
import path from 'node:path';
import * as autoDetect from '../dist/channels/auto-detect.js';

console.log('[1] 导出:', Object.keys(autoDetect).join(', '));

// 模拟 ChannelManager
const registered = [];
const fakeManager = {
  register: (handler, config) => {
    registered.push({ id: handler.id, name: handler.name, config });
    console.log('  [register] id =', handler.id, ' name =', handler.name);
  },
  getStatusSummary: () => [],
};

const cwd = process.cwd();
console.log('[2] cwd =', cwd);

try {
  const info = await autoDetect.registerConfigChannels(fakeManager, cwd);
  console.log('\n[3] registerConfigChannels 返回 channelsInfo =', JSON.stringify(info));
  console.log('[4] 已注册渠道 =', registered.map(r => r.id).join(', ') || '(无)');
  console.log('[5] 插件列表 =', autoDetect.getChannelPlugins().map(p => p.configKey).join(', ') || '(无)');
} catch (e) {
  console.error('\n❌ registerConfigChannels 抛错:', e);
  process.exit(1);
}

if (!registered.some(r => r.id === 'qq')) {
  console.log('\n❌ QQ 未被注册');
  process.exit(1);
}
console.log('\n✅ QQ 已被注册（说明启动流程本身没问题，问题在 start()）');
