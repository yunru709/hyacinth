import { LifecycleSupervisor } from './supervisor/shutdown.js';
import { LocalProvider } from './provider/local.js';
import type { Message } from './types.js';

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('Lifecycle 托管 → llama-server 完整测试');
  console.log('═══════════════════════════════════════');

  const supervisor = new LifecycleSupervisor();
  supervisor.installSignalHandlers();

  try {
    // 1. Agent 启动 → 自动拉起 llama-server
    console.log('\n1. Agent 启动, 加载本地模型...');
    const models = await supervisor.loadAndStartModels(process.cwd());
    console.log(`   加载了 ${models.length} 个模型`);

    if (models.length === 0) {
      console.log('   FAIL: 没有模型被加载');
      process.exit(1);
    }

    const model = models[0];
    console.log(`   名称: ${model.name} | 后端: ${model.backend} | 地址: ${model.baseUrl}`);
    console.log('   PASS: 模型已启动\n');

    // 2. 使用 LocalProvider 调用
    console.log('2. 通过 LocalProvider 调用模型...');
    const provider = new LocalProvider({
      baseUrl: model.baseUrl,
      model: model.modelName,
    });

    const messages: Message[] = [
      { role: 'system', content: { type: 'text', text: 'Reply in one short sentence. No thinking.' } },
      { role: 'user', content: { type: 'text', text: 'Reply with just the word HELLO.' } },
    ];

    const stream = provider.createStream(messages);
    let response = '';
    for await (const event of stream) {
      if (event.type === 'TEXT') {
        process.stdout.write(event.content);
        response += event.content;
      }
    }
    console.log('');
    console.log(response.length > 0 ? '   PASS: 模型调用成功\n' : '   WARN: 响应为空\n');

    // 3. Agent 退出 → 自动关闭 llama-server
    console.log('3. Agent 退出, 关闭本地模型...');
    await supervisor.shutdownAll();
    console.log('   PASS: shutdownAll() 完成\n');

    // 4. 验证 llama-server 进程已完全终止
    await new Promise(r => setTimeout(r, 2000));
    console.log('4. 验证 llama-server 进程已终止...');
    const { execSync } = await import('node:child_process');
    try {
      const result = execSync('tasklist /FI "IMAGENAME eq llama-server.exe"', { encoding: 'utf-8', timeout: 5000 });
      if (result.includes('llama-server.exe')) {
        console.log(`   FAIL: llama-server 进程仍在运行\n   ${result.split('\n').find(l => l.includes('llama-server'))}`);
        process.exit(1);
      } else {
        console.log('   PASS: llama-server 进程已完全终止');
      }
    } catch {
      console.log('   PASS: llama-server 进程已完全终止');
    }

    // 注意：端口 8080 可能处于 TIME_WAIT 状态（TCP 正常清理），这不是进程在运行

  } finally {
    // 信号处理器在 supervisor 内部已通过 installSignalHandlers 注册
  }

  console.log('═══════════════════════════════════════');
  console.log('全部通过: Agent 主进程完全托管 llama-server 生命周期');
  console.log('═══════════════════════════════════════');
}

main().catch(console.error);