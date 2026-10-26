/**
 * TUI /tts 命令探针：验证 ① 命令已注册 ② childrenProvider 真能返回三引擎子项
 * ③ 面板描述可读。
 *
 * ⚠️ 必须先把配置中心 initialize + load 好：`/tts` 的 childrenProvider 内部走
 * `RuntimeConfigCenter.getInstance().get(...)`。单例未初始化时读到 undefined
 * ⇒ breeze 路径为空 ⇒ 全部显示「未就绪」，那是**假状态**（我第一次就踩了）。
 * 初始化顺序照抄 tui.ts:676-681。
 *
 * 用法：node tools-dev/tui-tts-cmd-probe.mjs
 */
const { RuntimeConfigCenter } = await import('../dist/runtime/config-center.js');
const { getDefaultConfig } = await import('../dist/runtime/defaults.js');
const { ConfigManager } = await import('../dist/setup/config.js');

const cm = new ConfigManager(process.cwd());
await cm.loadEnvKeys();
const persisted = await cm.load();
const cc = RuntimeConfigCenter.getInstance();
cc.initialize(getDefaultConfig(), cm);
cc.merge(persisted);

const { CommandRegistry } = await import('../dist/ui/command-registry.js');

const reg = CommandRegistry.getInstance(process.cwd());
const cmd = reg.find('tts');
if (!cmd) {
  console.error('❌ /tts 未注册到 CommandRegistry');
  process.exit(1);
}
console.log(`✅ /tts 已注册：${cmd.description}`);
console.log(`   category=${cmd.category} icon=${cmd.icon} executeLocal=${cmd.executeLocal}`);
console.log(`   有 childrenProvider: ${typeof cmd.childrenProvider === 'function'}`);

if (typeof cmd.childrenProvider !== 'function') {
  console.error('❌ 缺 childrenProvider ⇒ 面板里点不出引擎');
  process.exit(1);
}

const children = await cmd.childrenProvider();
console.log(`\n=== childrenProvider 返回 ${children.length} 项 ===`);
for (const c of children) {
  console.log(`  ${c.icon} ${String(c.name).padEnd(14)} ${c.description}`);
}

const kinds = children.map((c) => c.name);
const expect = ['cosyvoice3', 'breeze-tts-2', 'online'];
const missing = expect.filter((k) => !kinds.includes(k));
if (missing.length) {
  console.error(`\n❌ 缺引擎子项：${missing.join(', ')}`);
  process.exit(1);
}
console.log('\n✅ 三个引擎子项齐全（点选后会回调 handleSlashSubCommand("tts/<kind>")）');
