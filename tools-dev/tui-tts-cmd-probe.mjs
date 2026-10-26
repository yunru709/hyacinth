/**
 * TUI /tts 命令探针：不重启进程，直接 import dist 的 CommandRegistry，
 * 验证 ① 命令已注册 ② childrenProvider 真能返回三引擎子项 ③ 桌面面板描述可读。
 *
 * 用法：node tools-dev/tui-tts-cmd-probe.mjs
 */
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
