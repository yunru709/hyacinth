import readline from 'node:readline';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, checkForUpdate, downloadWithProgress, findExtractedDir, installUpdate } from '../update/index.js';
import chalk from 'chalk';
import { Command } from 'commander';
import type { ProviderType, ProviderConfig } from '../types.js';
import type { Provider } from '../provider/interface.js';
import { ProviderManager } from '../provider/manager.js';
import { getProviderConfigLoader } from '../provider/config.js';
import { toProjectKey } from '../utils/misc.js';
import { LocalProvider } from '../provider/local.js';
import { ConversationStore } from '../memory/conversation.js';
import { EventStore } from '../memory/events.js';
import { StatsManager } from '../memory/stats.js';
import { SessionManager } from '../memory/session.js';
import { AgentLoop } from '../orchestrator/loop.js';
import type { OutputHandler } from '../orchestrator/loop.js';
import { LifecycleSupervisor } from '../supervisor/shutdown.js';
import { installGlobalReaper } from '../lifecycle/global-registry.js';
import { runTui } from './tui.js';
import { createAgent } from './factory.js';
import { ConfigManager, API_KEY_MAP, DEFAULT_MAX_CONTEXT_TOKENS } from '../setup/config.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { SetupWizard } from '../setup/wizard.js';
import { runGenerationWizard } from '../setup/generation-wizard.js';
import { PROVIDER_MODELS } from '../setup/model-defaults.js';
import { getModelCatalogLoader } from '../provider/model-catalog-loader.js';
import { DEFAULT_PERSONA_DIR, ensurePersonaFiles } from '../setup/persona-bootstrap.js';
import {
  RESTART_SESSION_MARKER,
  RESTART_CONTINUATION_MARKER,
  RESTART_AFTER_UPDATE_EXIT_CODE,
  GUARDIAN_ENV,
  consumeMarker,
  markerIsFresh,
  removeMarker,
  writeRestartReason,
  takeRestartContinuation,
} from '../supervisor/protocol.js';
import { createLogger } from '../logging/logger.js';
import { loadRestartSnapshot } from '../session-channel.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { RuntimeConfigCenter } from '../runtime/config-center.js';
import { createConfigDomain } from '../ui-protocol/domains/config.js';
import { createSessionDomain } from '../ui-protocol/domains/session.js';
import type { FullConfig } from '../runtime/config-schema.js';

const logger = createLogger('cli');

// ============================================================
// Helpers for nested object path access (used by config get/set)
// ============================================================

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let next = current[part];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      next = {};
      current[part] = next;
    }
    current = next as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Try to parse a CLI string value: JSON first, then fall back to raw string. */
function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== '') return num;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}


/**
 * Create a CLI-style OutputHandler that writes colored text to stdout.
 */
function createCliHandler(): OutputHandler {
  let toolsShown = 0;

  return {
    onText(content) {
      process.stdout.write(chalk.white(content));
    },
    onThinking(content) {
      process.stdout.write(chalk.gray(content));
    },
    onToolUse(name, inputSummary) {
      toolsShown++;
      process.stdout.write(
        '\n' + chalk.cyan(`[Tool: ${name}]`) + chalk.dim(` ${inputSummary}`) + '\n',
      );
    },
    onToolResult(content, isError) {
      const prefix = isError ? chalk.red('[Error] ') : '';
      const lines = content.split('\n');
      const preview = lines.slice(0, 5).join('\n');
      const ellipsis =
        lines.length > 5
          ? chalk.dim(`\n... (${lines.length - 5} more lines)`)
          : '';
      process.stdout.write(prefix + chalk.dim(preview) + ellipsis + '\n');
    },
    onStatus(message, level) {
      const color =
        level === 'error'
          ? chalk.red
          : level === 'warn'
            ? chalk.yellow
            : chalk.dim;
      process.stdout.write('\n' + color(message) + '\n');
    },
    onFlush() {
      process.stdout.write('\n');
    },
    onPermissionRequest(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always' | 'aor'> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      return new Promise((resolve) => {
        const inputStr = Object.entries(input)
          .map(([k, v]) => `${k}=${String(v).substring(0, 60)}`)
          .join(', ');
        process.stdout.write(
          chalk.yellow(`\n[Permission] ${toolName}(${inputStr}) - [Y]es once / [O] AOR all (session) / [A]lways this tool (session) / [N]o? `) +
          chalk.dim(`(Always/AOR are session-scoped; use allow_tool to persist globally)`) +
          ' ',
        );
        rl.question('', (answer: string) => {
          rl.close();
          const lower = answer.toLowerCase();
          if (lower === 'y' || lower === 'yes') resolve('yes');
          else if (lower === 'o' || lower === 'aor') resolve('aor');
          else if (lower === 'a' || lower === 'always') resolve('always');
          else if (lower === 'n' || lower === 'no') resolve('no');
          else resolve('no');
        });
      });
    },
    onInterrupt() {
      process.stdout.write('\n' + chalk.yellow('Interrupted.\n'));
    },
  };
}

/**
 * CLI 入口 — 使用 commander 解析参数，启动 Agent
 */
export async function runCli(): Promise<void> {
  const program = new Command();

  program
    .name('hyacinth')
    .description('AI Agent with context management')
    .version((() => { try { return JSON.parse(fsSync.readFileSync(path.resolve(path.dirname(process.argv[1]), '..', 'package.json'), 'utf-8')).version; } catch { return '0.0.0'; } })())
    .option('-i, --interactive', '交互模式')
    .option('-p, --provider <type>', 'Provider: anthropic | openai | deepseek | local')
    .option('-m, --model <name>', '模型名称')
        .option('--max-turns <n>', '轮次统计上限', '100')
    .option('--max-context <tokens>', '最大上下文 Token', String(DEFAULT_MAX_CONTEXT_TOKENS))
    .option('--max-messages <n>', '每个 session 的最大消息数', '10000')
    .option('--continue', '继续最近的 session')
    .option('--session <id>', '恢复指定 session')
    .option('--tui', '使用 TUI 模式（全屏终端界面）')
    .option('--start-model', '启动本地模型（配合 --provider local 使用）')
    .option('--skip-setup', '跳过首次启动引导 (Skip first-run setup)')
    .option('--local-model <name>', '本地模型名称（用于压缩通道）')
    .option('--channel <id>', '会话归属渠道标识（缺省无渠道 → 裸日期 ID）。供其他 Agent/脚本经 bash 派发时标记来源，使会话带 <id>_ 前缀并可被按渠道恢复')
    .argument('[prompt]', '单次执行的 prompt')
    .action(async (prompt: string | undefined, options: Record<string, unknown>) => {
      try {
        await executeAction(prompt, options);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('CLI error', undefined, { error: message });
        process.exit(1);
      }
    });

  // setup 子命令
  program
    .command('setup')
    .description('运行配置向导 (Run setup wizard)')
    .action(async () => {
      const configManager = new ConfigManager(process.cwd());
      const existing = await configManager.load().catch(() => undefined);
      const result = await new SetupWizard().run(existing);

      // 初始化 persona 文件
      const personaDir = DEFAULT_PERSONA_DIR;
      await ensurePersonaFiles(personaDir);

      // 如果用户选择进入 TUI，自动启动
      if (result.enterTui && result.config.provider) {
        await configManager.loadEnvKeys();
        await executeAction(undefined, {
          provider: result.config.provider,
          model: result.config.model,
          maxTurns: String(result.config.maxTurns),
          maxContext: String(result.config.maxContext),
          tui: true,
          skipSetup: true,
        });
      }
    });
  // setup-generation 子命令（生成能力配置向导，独立于主 setup）
  program
    .command('setup-generation')
    .description('配置生成能力（图片/视频/音频厂商 + API Key + 模型）')
    .action(async () => {
      const configManager = new ConfigManager(process.cwd());
      await runGenerationWizard(configManager);
    });

  // doctor 子命令
  program
    .command('doctor')
    .description('系统诊断 + 自动修复 (System diagnostics & auto-fix)')
    .option('--fix', '自动修复检测到的问题')
    .option('--prompts', '显示原始 Persona 提示词')
    .action(async (options: { fix?: boolean; prompts?: boolean }) => {
      const { runDoctor } = await import('../diagnostics/doctor.js');
      await runDoctor({ fix: options.fix, showPrompts: options.prompts });
    });

  // tui 子命令
  program
    .command('tui')
    .description('启动 TUI 全屏终端界面')
    .option('-p, --provider <name>', 'Provider')
    .option('-m, --model <name>', '模型名称')
        .option('--max-turns <n>', '轮次统计上限', '100')
    .option('--max-context <tokens>', '最大上下文 Token')
    .option('--continue', '继续最近的 session')
    .option('--session <id>', '恢复指定 session')
    .option('--start-model', '启动本地模型')
    .option('--skip-setup', '跳过首次引导')
    .option('--guardian', '启用守护进程（自动重启）')
    .action(async (options) => {
      await executeAction(undefined, { ...options, tui: true });
    });

  // serve 与 webui 子命令共用的服务器启动逻辑
  async function runServer(options: Record<string, string>, webuiEnabled: boolean): Promise<void> {
    const { startServer } = await import('./server.js');
    const port = webuiEnabled
      ? parseInt(options.webuiPort || options.port || '3100', 10)
      : parseInt(options.port || '3000', 10);

    // ── 单实例守卫 ────────────────────────────────────────────────
    // 目标端口已被占用（大概率是已在运行的 hyacinth 实例）时提示并退出，
    // 防止重复启动造成后端与 MCP 子进程树堆积。多实例请用 --port 换端口。
    if (await isPortInUse(port)) {
      console.error(
        `\n[hyacinth] 端口 ${port} 已被占用（大概率已有 hyacinth 实例在运行：http://127.0.0.1:${port}）。\n` +
        `[hyacinth] 如需多实例，请用 --port 指定其他端口。本次启动退出。\n`,
      );
      process.exit(1);
    }

    // WebUI 静态资源必须基于模块自身位置（dist/gateway/）解析，而非 process.cwd()：
    // 全局命令可在任意目录运行（如 C:\Users\xxx），cwd 下没有 src/webui 或 dist/webui。
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const srcWebui = path.resolve(__dirname, '../../src/webui');
    const distWebui = path.resolve(__dirname, '../webui');
    const webuiRoot = webuiEnabled
      ? (fsSync.existsSync(srcWebui) ? srcWebui : distWebui)
      : undefined;

    const { manager } = await startServer({
      port,
      cwd: process.cwd(),
      provider: options.provider,
      model: options.model,
      maxTurns: parseInt(options.maxTurns || '100', 10),
      maxContext: parseInt(options.maxContext || String(DEFAULT_MAX_CONTEXT_TOKENS), 10),
      apiKey: options.apiKey,
      corsOrigin: options.corsOrigin,
      webuiRoot,
    });

    // WebUI 模式：后端就绪后自动拉起默认浏览器
    if (webuiEnabled) {
      openBrowser(`http://127.0.0.1:${port}`);
    }

    const shutdown = async () => {
      console.log('\nShutting down...');
      await manager.stopAll();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /**
   * 检测端口是否已被占用（尝试绑定 127.0.0.1:port）。
   */
  function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(true));
      srv.once('listening', () => srv.close(() => resolve(false)));
      srv.listen(port, '127.0.0.1');
    });
  }

  /**
   * 用系统默认浏览器打开 URL（跨平台，失败不阻塞后端）。
   * Windows → start；macOS → open；Linux → xdg-open。
   */
  function openBrowser(url: string): void {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => { /* 打开失败不影响服务 */ });
      child.unref();
      console.log(`\nWebUI 已启动：${url}`);
    } catch {
      console.log(`\nWebUI 已启动：${url}（请手动在浏览器打开）`);
    }
  }

  // serve 子命令
  program
    .command('serve')
    .description('启动 HTTP API 服务器 (Start HTTP API server)')
    .option('-p, --port <port>', 'API 服务器端口', '3000')
    .option('--api-key <key>', 'API 认证密钥（或设置 HYACINTH_API_KEY 环境变量）')
    .option('--cors-origin <origin>', 'CORS 允许的域名（默认 *）')
    .option('--provider <type>', 'Provider 类型')
    .option('--model <name>', '模型名称')
        .option('--max-turns <n>', '轮次统计上限', '100')
    .option('--max-context <tokens>', '最大上下文 Token', String(DEFAULT_MAX_CONTEXT_TOKENS))
    .option('--webui', '启用 WebUI 静态服务（服务 webui/ 目录，端口取 --webui-port）')
    .option('--webui-port <port>', 'WebUI 服务端口（--webui 时生效，默认 3100）', '3100')
    .action(async (options: Record<string, string>) => {
      await runServer(options, !!options.webui);
    });

  // webui 子命令 — 统一入口：hyacinth webui（等价 hyacinth serve --webui，默认端口 3100）
  program
    .command('webui')
    .description('启动 WebUI 服务（HTTP API + WebUI 静态页面，默认端口 3100）')
    .option('-p, --port <port>', 'WebUI 服务端口', '3100')
    .option('--provider <type>', 'Provider 类型')
    .option('--model <name>', '模型名称')
    .option('--max-turns <n>', '轮次统计上限', '100')
    .option('--max-context <tokens>', '最大上下文 Token', String(DEFAULT_MAX_CONTEXT_TOKENS))
    .option('--api-key <key>', 'API 认证密钥（或设置 HYACINTH_API_KEY 环境变量）')
    .option('--cors-origin <origin>', 'CORS 允许的域名（默认 *）')
    .action(async (options: Record<string, string>) => {
      await runServer(options, true);
    });

  // Session management commands
  const sessionCmd = program.command('session').description('Session management commands');

  sessionCmd
    .command('list')
    .description('List all sessions for the current project')
    .option('-p, --project <dir>', 'Project directory', process.cwd())
    .action(async (options) => {
      const projectKey = toProjectKey(options.project);
      const sessionManager = new SessionManager(projectKey);
      const sessions = await sessionManager.list();

      if (sessions.length === 0) {
        logger.info('No sessions found.');
        return;
      }

      logger.info('Found sessions', { count: sessions.length });
      for (const s of sessions) {
        const conversationStore = new ConversationStore();
        const msgCount = await conversationStore.count(sessionManager.getSessionDir(s.id));
        logger.info('Session info', { id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: msgCount });
      }
    });

  sessionCmd
    .command('delete <sessionId>')
    .description('Delete a session and all its data')
    .option('-p, --project <dir>', 'Project directory', process.cwd())
    .action(async (sessionId, options) => {
      // 协议收口（T6 第二批）：经 ui-protocol session 域 handler 执行——与
      // WebUI/TUI 的 session.delete 同一存在性校验（ensureExists）与删除路径。
      // list/export 未收口：list 为读操作（优先级最低）；export 语义不同源
      // （CLI 单会话 JSON vs 域 zip 打包），硬收口会改变输出物。
      const projectKey = toProjectKey(options.project);
      const sessionManager = new SessionManager(projectKey);
      const domain = createSessionDomain({ sessionManager });
      try {
        await (domain.delete as (p: unknown) => Promise<unknown>)({ sessionId });
      } catch {
        logger.error('Session not found', undefined, { sessionId });
        process.exit(1);
      }
      logger.info('Deleted session', { sessionId });
    });

  sessionCmd
    .command('export <sessionId>')
    .description('Export a session to a JSON file')
    .option('-p, --project <dir>', 'Project directory', process.cwd())
    .option('-o, --output <file>', 'Output file path')
    .action(async (sessionId, options) => {
      const projectKey = toProjectKey(options.project);
      const sessionManager = new SessionManager(projectKey);
      const sessionDir = sessionManager.getSessionDir(sessionId);

      try {
        await fs.access(sessionDir);
      } catch {
        logger.error('Session not found', undefined, { sessionId });
        process.exit(1);
      }

      const conversationStore = new ConversationStore();
      const eventStore = new EventStore();
      const statsManager = new StatsManager();

      const [messages, events, stats] = await Promise.all([
        conversationStore.readAll(sessionDir),
        eventStore.readAll(sessionDir),
        statsManager.get(sessionDir),
      ]);

      const exportData = {
        sessionId,
        projectKey,
        exportedAt: new Date().toISOString(),
        messages,
        events,
        stats,
      };

      const outputPath = options.output || `./${sessionId}.json`;
      await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
      logger.info('Exported session', { outputPath });
    });

  sessionCmd.action(() => {
    sessionCmd.outputHelp();
  });

  // ============================================================
  // config group: agent config get/set/schema/reset
  // ============================================================
  const configCmd = program
    .command('config')
    .description('Manage agent configuration');

  // ============================================================
  // config group: agent config get/set/schema/reset
  // 协议收口（T6 第一批）：经 ui-protocol config 域 handler 执行。
  // CLI 是单发进程、无 RPC 对端，但直接复用协议域 handler —— 与 WebUI/TUI
  // 经 RPC 调用的是同一份校验/持久化逻辑（代码路径唯一）。
  // ============================================================

  /**
   * 构造 CLI 侧协议 config 域。RuntimeConfigCenter 与协议会话同源：
   * initialize 装入默认 schema（createConfigDomain 内部即真实配置中心）。
   * RuntimeConfigCenter 结构满足 ConfigCenterLike（FullConfig 与 Record 的
   * index-signature 差异仅类型面，与 tui.ts 传参同款断言）；config 域实现
   * 均不使用 ctx —— 直调时剥掉 DomainAction 签名的第二参。
   */
  function createCliConfigDomain() {
    const cm = new ConfigManager(process.cwd());
    const cc = RuntimeConfigCenter.getInstance();
    cc.initialize(getDefaultConfig(), cm);
    const domain = createConfigDomain({
      configCenter: cc as unknown as Parameters<typeof createConfigDomain>[0]['configCenter'],
    });
    const direct = domain as unknown as {
      get(params: { path?: string }): { path?: string; value: unknown };
      set(params: { path: string; value: unknown }): Promise<unknown>;
      reset(params: { path?: string }): Promise<unknown>;
    };
    return { cc, domain: direct };
  }

  /** 磁盘现状 → runtime 覆盖（get 语义等价于读盘；与协议会话装配一致） */
  async function loadDiskConfigIntoCenter(cc: RuntimeConfigCenter, cm: ConfigManager): Promise<void> {
    cc.merge((await cm.load()) as never);
  }

  configCmd
    .command('get [path]')
    .description('Get a config value by dot-path, or the full config if no path given')
    .action(async (path?: string) => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      try {
        const resp = domain.get({ path }) as { path?: string; value: unknown };
        process.stdout.write(JSON.stringify(resp.value, null, 2) + '\n');
      } catch (err) {
        logger.error(`Config get failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  configCmd
    .command('set <path> <value>')
    .description('Set a config value by dot-path and save (changes take effect on next restart)')
    .action(async (path: string, value: string) => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const parsed = parseValue(value);
      try {
        await domain.set({ path, value: parsed });
      } catch (err) {
        logger.error(`Config set failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      logger.info('Config updated', { path, value: parsed });
      logger.info('Changes will take effect on next restart.');
    });

  configCmd
    .command('schema')
    .description('Print the default configuration schema')
    .action(() => {
      const defaults = getDefaultConfig();
      process.stdout.write(JSON.stringify(defaults, null, 2) + '\n');
    });

  configCmd
    .command('reset [path]')
    .description('Reset a config path (or all config) to defaults')
    .action(async (path?: string) => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      try {
        await domain.reset({ path });
      } catch (err) {
        logger.error(`Config reset failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      if (path) {
        logger.info('Config path reset to default', { path });
      } else {
        logger.info('All config reset to defaults.');
      }
      logger.info('Changes will take effect on next restart.');
    });

  configCmd.action(() => {
    configCmd.outputHelp();
  });

  // ============================================================
  // model group: agent model switch/list/info
  // ============================================================
  const modelCmd = program
    .command('model')
    .description('Manage AI model providers');

  modelCmd
    .command('switch <provider>')
    .description('Switch to a different provider (changes its default model)')
    .action(async (provider: string) => {
      const models = PROVIDER_MODELS[provider];
      if (!models || models.length === 0) {
        logger.error('Unknown provider', undefined, { provider, available: Object.keys(PROVIDER_MODELS) });
        process.exit(1);
      }

      // T8 二批·语义修复：schema 无顶层 provider/model 键 —— 真实结构是
      // provider.active（当前激活）+ provider.<name>.model（该 provider 默认模型）。
      // 旧实现写 cfg.provider/cfg.model 顶层非法键，装配方（读 provider.active）
      // 永远看不到 → switch 从未生效。现修正写入位置。完整协议化需经 model 域
      // main 通道绑定（registry.setChannelModel），CLI 单发进程无 loop，标注待后续。
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;
      const prov = (cfg.provider as Record<string, unknown>) ?? {};
      prov.active = provider;
      const providerNode = (prov[provider] as Record<string, unknown>) ?? {};
      providerNode.model = models[0].id;
      prov[provider] = providerNode;
      cfg.provider = prov;
      await cm.save(cfg as unknown as Parameters<ConfigManager['save']>[0]);
      logger.info('Provider switched', { provider, model: models[0].id });
      logger.info('Changes will take effect on next restart.');
    });

  modelCmd
    .command('list')
    .description('List all registered model providers')
    .action(() => {
      const entries = Object.entries(PROVIDER_MODELS);
      if (entries.length === 0) {
        logger.info('No providers registered.');
        return;
      }
      for (const [provider, models] of entries) {
        const modelList = models.map((m) => m.id).join(', ');
        process.stdout.write(`${chalk.bold(provider)}\n`);
        process.stdout.write(chalk.dim(`  models: ${modelList}\n`));
      }
    });

  modelCmd
    .command('info')
    .description('Show current provider and model details')
    .action(async () => {
      // 协议收口（T8 二批）：经 config 域读取 provider.active 与对应默认模型
      // （schema 真实结构）；模型目录详情仍来自静态表 PROVIDER_MODELS
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const provider = (domain.get({ path: 'provider.active' }) as { value?: string }).value;
      const model =
        provider === undefined
          ? undefined
          : (domain.get({ path: `provider.${provider}.model` }) as { value?: string }).value;
      logger.info('Current provider', { provider, model });

      const models = PROVIDER_MODELS[provider ?? ''];
      if (models) {
        const current = models.find((m) => m.id === model);
        if (current) {
          logger.info('Model details', {
            name: current.name,
            contextWindow: current.contextWindow,
            maxOutputTokens: current.maxOutputTokens,
            reasoning: current.reasoning ?? false,
          });
        }
      }
    });

  modelCmd.action(() => {
    modelCmd.outputHelp();
  });

  // ============================================================
  // skill group: agent skill enable/disable/list
  // ============================================================
  const skillCmd = program
    .command('skill')
    .description('Manage agent skills');

  skillCmd
    .command('enable <name>')
    .description('Enable a skill (removes it from skills.disabled, takes effect on next restart)')
    .action(async (name: string) => {
      // 协议收口（T8 二批）+ 语义修复：运行时消费的格式是 skills.disabled:
      // string[] 黑名单（runtime-wiring 装配过滤 / runtime-control toggle 同款）。
      // 旧实现写 cfg.skills[name]=bool，无任何消费方 → enable 从未真正生效。
      // 现在经 config 域把 name 从 disabled 数组移除。
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const cur = ((domain.get({ path: 'skills.disabled' }) as { value?: unknown }).value ?? []) as string[];
      const next = cur.filter((x) => x !== name);
      try {
        await domain.set({ path: 'skills.disabled', value: next });
      } catch (err) {
        logger.error(`Skill enable failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      logger.info('Skill enabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  skillCmd
    .command('disable <name>')
    .description('Disable a skill (adds it to skills.disabled, takes effect on next restart)')
    .action(async (name: string) => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const cur = ((domain.get({ path: 'skills.disabled' }) as { value?: unknown }).value ?? []) as string[];
      const next = cur.includes(name) ? cur : [...cur, name];
      try {
        await domain.set({ path: 'skills.disabled', value: next });
      } catch (err) {
        logger.error(`Skill disable failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      logger.info('Skill disabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  skillCmd
    .command('list')
    .description('List disabled skills (skills not listed are enabled by default)')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const disabled = ((domain.get({ path: 'skills.disabled' }) as { value?: unknown }).value ?? []) as string[];

      if (disabled.length === 0) {
        logger.info('All skills enabled (skills.disabled is empty).');
        return;
      }

      for (const name of disabled) {
        process.stdout.write(`${chalk.bold(name)} ${chalk.gray('disabled')}\n`);
      }
    });

  skillCmd.action(() => {
    skillCmd.outputHelp();
  });

  // ============================================================
  // tool group: agent tool enable/disable/list
  // ============================================================
  const toolCmd = program
    .command('tool')
    .description('Manage agent tools');

  toolCmd
    .command('enable <name>')
    .description('Enable a tool (removes it from tools.disabled, takes effect on next restart)')
    .action(async (name: string) => {
      // 协议收口（T8 二批）+ 语义修复：运行时消费 tools.disabled: string[]
      // 黑名单；旧实现写 cfg.tools[name]=bool 无消费方 → enable 从未生效。
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const cur = ((domain.get({ path: 'tools.disabled' }) as { value?: unknown }).value ?? []) as string[];
      const next = cur.filter((x) => x !== name);
      try {
        await domain.set({ path: 'tools.disabled', value: next });
      } catch (err) {
        logger.error(`Tool enable failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      logger.info('Tool enabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  toolCmd
    .command('disable <name>')
    .description('Disable a tool (adds it to tools.disabled, takes effect on next restart)')
    .action(async (name: string) => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const cur = ((domain.get({ path: 'tools.disabled' }) as { value?: unknown }).value ?? []) as string[];
      const next = cur.includes(name) ? cur : [...cur, name];
      try {
        await domain.set({ path: 'tools.disabled', value: next });
      } catch (err) {
        logger.error(`Tool disable failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      logger.info('Tool disabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  toolCmd
    .command('list')
    .description('List disabled tools (tools not listed are enabled by default)')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const { cc, domain } = createCliConfigDomain();
      await loadDiskConfigIntoCenter(cc, cm);
      const disabled = ((domain.get({ path: 'tools.disabled' }) as { value?: unknown }).value ?? []) as string[];

      if (disabled.length === 0) {
        logger.info('All tools enabled (tools.disabled is empty).');
        return;
      }

      for (const name of disabled) {
        process.stdout.write(`${chalk.bold(name)} ${chalk.gray('disabled')}\n`);
      }
    });

  toolCmd.action(() => {
    toolCmd.outputHelp();
  });

  program
    .command('supervisor-status')
    .description('查看 Supervisor 监督状态（重启原因存档 / 标记残留 / git 摘要；进程外诊断）')
    .action(async () => {
      const { GitManager } = await import('../evolution/git-manager.js');
      const {
        readRestartReason,
        readMarker,
        RESTART_SESSION_MARKER,
        RESTART_CONTINUATION_MARKER,
        isUnderGuardian,
      } = await import('../supervisor/protocol.js');

      process.stderr.write('── Supervisor 状态 ──\n');
      process.stderr.write(`guardian 守护: ${isUnderGuardian() ? '是（重启兜底可用）' : '否（本命令经 --no-guardian 或直接子进程运行）'}\n`);

      const reason = readRestartReason();
      if (reason) {
        process.stderr.write(`上次重启: code=${reason.code} source=${reason.source}${reason.detail ? ` detail=${reason.detail}` : ''}\n`);
      } else {
        process.stderr.write('上次重启: 无存档（.restart-reason 不存在）\n');
      }

      for (const [name, desc] of [
        [RESTART_SESSION_MARKER, '会话快照'],
        [RESTART_CONTINUATION_MARKER, '续工指令'],
      ] as const) {
        const content = readMarker(name);
        if (content !== null) {
          process.stderr.write(`标记残留: ${name}（${desc}）— 非对应启动模式时会残留，serve 启动会自动清理\n`);
        }
      }

      process.stderr.write('退出码语义: 42=重启 43=更新后重启 44=插件热更新兜底重启\n');

      try {
        const gitManager = new GitManager(process.cwd());
        const isRepo = await gitManager.isRepo();
        if (!isRepo) {
          process.stderr.write('git: 当前目录不在 git 仓库内\n');
          return;
        }
        const dirty = await gitManager.hasUncommittedChanges();
        process.stderr.write(`git: 工作区${dirty ? '脏（回合锚点将在回合开始时提交）' : '干净'}\n`);
        const autoCommits = await gitManager.logGrep('auto:', 5);
        if (autoCommits.length > 0) {
          process.stderr.write('最近 auto 提交:\n');
          for (const c of autoCommits) {
            process.stderr.write(`  ${c.hash.slice(0, 8)}  ${c.message}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`git: 摘要失败（${err instanceof Error ? err.message : String(err)}）\n`);
      }
    });

  // ── 架构监督（扩展注册表方案）：进程外诊断，不启动 agent ──
  const archCmd = program
    .command('arch')
    .description('架构监督：可替换点目录 / 扩展名单 / 插件裁决（进程外诊断）');

  archCmd
    .command('list')
    .description('一屏可见：全部可替换点 + 名单声明 + 插件当前裁决值')
    .argument('[kind]', '按种类过滤（slot/service/provider/router/source/adapter/channel/tool/skill/agent/plugin）')
    .action(async (kind: string | undefined) => {
      const { REPLACEABLE_POINTS, loadExtensionManifest } = await import('../supervisor/extension-registry.js');
      const { manifest, errors, paths } = loadExtensionManifest(process.cwd());

      process.stderr.write('── 可替换点目录 ──\n');
      const points = kind ? REPLACEABLE_POINTS.filter((p) => p.kind === kind) : REPLACEABLE_POINTS;
      if (points.length === 0) process.stderr.write(`（无 kind=${kind} 的条目）\n`);
      for (const p of points) {
        process.stderr.write(`  ${p.id}${p.defaultImpl ? ` = ${p.defaultImpl}` : ''}  # ${p.description}\n`);
      }

      process.stderr.write('── 名单（extension-registry.json）──\n');
      process.stderr.write(`  全局: ${paths.globalPath}\n  项目: ${paths.projectPath}\n`);
      if (errors.length > 0) {
        process.stderr.write(`  ⚠ 名单校验错误:\n`);
        for (const e of errors) process.stderr.write(`    - ${e}\n`);
      }
      if (manifest.replacements.length === 0 && manifest.plugins.length === 0 && manifest.orders.length === 0) {
        process.stderr.write('  （空名单 —— 全部走出厂默认）\n');
      }
      for (const r of manifest.replacements) {
        process.stderr.write(`  替换 ${r.point} ← ${r.impl}${r.module ? `（module: ${r.module}）` : ''}\n`);
      }
      for (const p of manifest.plugins) {
        process.stderr.write(`  插件 ${p.id}: enabled=${p.enabled}${p.mountAt ? ` mountAt=${p.mountAt}` : ''}\n`);
      }
      for (const o of manifest.orders) {
        process.stderr.write(`  排序 ${o.point}: ${o.order.join(' > ')}\n`);
      }

      // 插件裁决值三源折叠预览：名单 > plugins.config.json > manifest.enabledByDefault
      try {
        const { PluginLoader } = await import('../plugins/loader.js');
        const loader = new PluginLoader(process.cwd());
        const discovered = await loader.discover();
        const pluginConfig = await loader.loadPluginConfig();
        if (discovered.length > 0) {
          process.stderr.write('── 已安装插件（裁决值预览）──\n');
          for (const m of discovered) {
            const fromList = manifest.plugins.find((p) => p.id === m.id);
            const resolved = fromList ? fromList.enabled : (pluginConfig[m.id]?.enabled ?? m.enabledByDefault ?? true);
            const src = fromList ? '名单' : (pluginConfig[m.id] !== undefined ? 'plugins.config' : 'manifest');
            process.stderr.write(`  ${m.id}: ${resolved ? '启用' : '停用'}（来源: ${src}）\n`);
          }
        }
      } catch {
        // 插件目录不可用则跳过预览
      }
    });

  archCmd
    .command('get <point>')
    .description('单点查询：目录定义 + 名单声明（如 hyacinth arch get provider:main）')
    .action(async (point: string) => {
      const { getReplaceablePoint, loadExtensionManifest } = await import('../supervisor/extension-registry.js');
      const def = getReplaceablePoint(point);
      if (!def) {
        process.stderr.write(`未知可替换点: ${point}\n（hyacinth arch list 查看全部）\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`点:   ${def.id} [${def.kind}]\n默认: ${def.defaultImpl ?? '（动态族）'}\n说明: ${def.description}\n`);
      const { manifest } = loadExtensionManifest(process.cwd());
      const repl = manifest.replacements.find((r) => r.point === point);
      if (repl) process.stderr.write(`名单: ← ${repl.impl}${repl.module ? `（module: ${repl.module}）` : ''}\n`);
      const order = manifest.orders.find((o) => o.point === point);
      if (order) process.stderr.write(`排序: ${order.order.join(' > ')}\n`);
      if (point.startsWith('plugin:')) {
        const decl = manifest.plugins.find((p) => p.id === point.slice('plugin:'.length));
        if (decl) process.stderr.write(`插件裁决: enabled=${decl.enabled}${decl.mountAt ? ` mountAt=${decl.mountAt}` : ''}\n`);
      }
      if (!repl && !order) process.stderr.write('名单: （无声明，走出厂默认）\n');
    });

  archCmd
    .command('toggle <pluginId> [state]')
    .description('插件名单裁决翻转：on/off（缺省取反；写项目级名单，serve 运行中由名单 watcher 热生效）')
    .action(async (pluginId: string, state: string | undefined) => {
      const { loadExtensionManifest, togglePluginInManifest } = await import('../supervisor/extension-registry.js');
      const current = loadExtensionManifest(process.cwd()).manifest.plugins.find((p) => p.id === pluginId)?.enabled ?? true;
      const enabled = state === undefined ? !current : state === 'on' || state === 'true';
      const result = togglePluginInManifest(process.cwd(), pluginId, enabled);
      if (!result.ok) {
        process.stderr.write(`[arch] ❌ ${result.error}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`[arch] ${pluginId}: enabled=${enabled} 已写入项目名单\n`);
    });

  // ── 插件管理（扩展注册表方案缺口 1）：安装进 .agent/plugins，生效与否由名单裁决 ──
  const pluginCmd = program
    .command('plugin')
    .description('插件管理：安装 / 列出 / 卸载（安装 = 放置文件；生效与否由名单与配置裁决）');

  pluginCmd
    .command('install <source>')
    .description('安装插件：本地插件目录路径，或 git 仓库 URL（克隆后识别 plugin.json）')
    .action(async (source: string) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      // P-Config 收敛：插件统一安装到全局 ~/.agent/plugins/
      const targetRoot = path.join(os.homedir(), '.agent', 'plugins');
      fs.mkdirSync(targetRoot, { recursive: true });
      const tmpDir = path.join(targetRoot, `.installing-${Date.now()}`);

      const isGit = /^https?:\/\/|^git@/.test(source);
      const srcDir = isGit
        ? await (async () => {
            const { execFileSync } = await import('node:child_process');
            process.stderr.write(`[plugin] git clone ${source} ...\n`);
            execFileSync('git', ['clone', '--depth', '1', source, tmpDir], { stdio: 'inherit' });
            return tmpDir;
          })()
        : path.resolve(source);

      try {
        const manifestPath = path.join(srcDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) {
          process.stderr.write(`[plugin] ❌ ${srcDir} 下没有 plugin.json\n`);
          process.exitCode = 1;
          return;
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { id?: string };
        if (!manifest.id) {
          process.stderr.write('[plugin] ❌ plugin.json 缺少 id 字段\n');
          process.exitCode = 1;
          return;
        }
        const target = path.join(targetRoot, manifest.id);
        if (fs.existsSync(target)) {
          process.stderr.write(`[plugin] ❌ 插件 ${manifest.id} 已存在（${target}）；先 uninstall 再安装\n`);
          process.exitCode = 1;
          return;
        }
        fs.cpSync(srcDir, target, { recursive: true });
        process.stderr.write(`[plugin] ✅ ${manifest.id} 已安装到 ${target}\n`);
        process.stderr.write('提示: 安装不等于生效 —— 默认启用；在名单（.agent/extension-registry.json）中声明 enabled:false 可停用，hyacinth arch toggle <id> off 快捷翻转。\n');
      } finally {
        if (isGit) fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

  pluginCmd
    .command('list')
    .description('列出已安装插件（目录、版本、入口）')
    .action(async () => {
      const { PluginLoader } = await import('../plugins/loader.js');
      const loader = new PluginLoader(process.cwd());
      const manifests = await loader.discover();
      if (manifests.length === 0) {
        process.stderr.write('（未发现已安装插件）\n');
        return;
      }
      for (const m of manifests) {
        process.stderr.write(`  ${m.id}@${m.version ?? '?'}  entry=${m.entry}${m.enabledByDefault === false ? '  (enabledByDefault: false)' : ''}\n`);
      }
    });

  pluginCmd
    .command('uninstall <pluginId>')
    .description('卸载插件：删除 .agent/plugins/<id> 目录（名单/plugins.config 中的声明保留，供重装后延续裁决）')
    .action(async (pluginId: string) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const target = path.join(process.cwd(), '.agent', 'plugins', pluginId);
      if (!fs.existsSync(target)) {
        process.stderr.write(`[plugin] ❌ ${target} 不存在（builtin plugins/ 目录不受 uninstall 管理）\n`);
        process.exitCode = 1;
        return;
      }
      fs.rmSync(target, { recursive: true, force: true });
      process.stderr.write(`[plugin] ✅ ${pluginId} 已卸载\n`);
    });

  program
    .command('backup')
    .description('对当前项目工作区做 git bundle + tag 双保险快照（Supervisor 方案 S4）')
    .argument('[label]', '备份标签（默认 backup；用于区分用途，如 pre-refactor）')
    .action(async (label: string | undefined) => {
      const { GitManager, createBackup } = await import('../evolution/index.js');
      const gitManager = new GitManager(process.cwd());
      try {
        const { bundlePath, tag } = await createBackup(gitManager, process.cwd(), label ?? 'backup');
        process.stderr.write(`[backup] ✅ 快照已创建\n`);
        process.stderr.write(`   bundle: ${bundlePath}\n   tag:    ${tag}\n`);
        process.stderr.write(`恢复: git clone <bundle 路径> 恢复全量仓；或 git checkout ${tag}（本仓内）\n`);
      } catch (err) {
        process.stderr.write(`[backup] ❌ ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  program
    .command('update')
    .description('Update hyacinth from GitHub releases or local source')
    .option('--repo <owner/name>', 'GitHub repo, e.g. user/hyacinth-ai')
    .option('--source <path>', 'Local source path (for dev builds)')
    .action(async (options: { repo?: string; source?: string }) => {
      const { execSync } = await import('node:child_process');
      const p = await import('node:path');
      const os = await import('node:os');
      const installDir = p.resolve(p.dirname(process.argv[1]), '..', '..');

      const cfg = loadConfig();
      const repo = options.repo || cfg.repo || '';
      const sourcePath = options.source || cfg.sourcePath || '';

      if (options.repo) { cfg.repo = options.repo; saveConfig(cfg); }
      if (options.source) { cfg.sourcePath = options.source; saveConfig(cfg); }

      if (repo) {
        // ── 远程 ──
        const currentVersion = JSON.parse(fsSync.readFileSync(p.join(installDir, 'package.json'), 'utf-8')).version;
        const result = await checkForUpdate(repo, currentVersion, msg => process.stderr.write(`[update] ${msg}\n`));
        if (!result) { process.stderr.write('[update] 检查失败\n'); process.exit(1); }
        const { version, downloadUrl } = result;

        process.stderr.write(`[update] 当前: v${version.current} → 最新: v${version.latest}`);
        if (!version.needsUpdate) {
          process.stderr.write(' — 已是最新\n');
          return;
        }
        process.stderr.write('\n');

        const tmpDir = p.join(os.tmpdir(), `hyacinth-update-${Date.now()}`);
        await downloadWithProgress(downloadUrl, tmpDir, p => {
          const bar = '█'.repeat(Math.floor(p.percent / 5)) + '░'.repeat(20 - Math.floor(p.percent / 5));
          process.stderr.write(`\r[update] 下载: ${bar} ${p.percent}% (${(p.downloaded / 1024 / 1024).toFixed(1)}MB / ${(p.total / 1024 / 1024).toFixed(1)}MB)`);
        });
        process.stderr.write('\n');

        process.stderr.write('[update] 解压中...\n');
        const zipPath = p.join(tmpDir, 'release.zip');
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });

        const extractedDir = findExtractedDir(tmpDir);
        installUpdate(extractedDir, installDir, msg => process.stderr.write(`[update] ${msg}\n`));
        fsSync.rmSync(tmpDir, { recursive: true, force: true });
        process.stderr.write(`[update] ✅ 已更新到 v${version.latest}。正在自动重启...\n`);
        // 43 = 更新完成：guardian 剥离子命令参数，重新拉起默认入口
        writeRestartReason({ code: RESTART_AFTER_UPDATE_EXIT_CODE, source: 'self-update', detail: `v${version.latest}` });
        process.exit(RESTART_AFTER_UPDATE_EXIT_CODE);

      } else if (sourcePath) {
        // ── 本地 ──
        process.stderr.write(`[update] 本地编译: ${sourcePath}\n`);
        execSync('pnpm build', { cwd: sourcePath, stdio: 'inherit' });
        const dst = p.join(installDir, 'dist');
        fsSync.rmSync(dst, { recursive: true, force: true });
        fsSync.cpSync(p.join(sourcePath, 'dist'), dst, { recursive: true });
        // 同步 package.json（版本号来源）
        fsSync.cpSync(p.join(sourcePath, 'package.json'), p.join(installDir, 'package.json'));
        const newVer = JSON.parse(fsSync.readFileSync(p.join(sourcePath, 'package.json'), 'utf-8')).version;
        process.stderr.write(`[update] ✅ 已更新到 v${newVer}。正在自动重启...\n`);
        // 43 = 更新完成：guardian 剥离子命令参数，重新拉起默认入口
        writeRestartReason({ code: RESTART_AFTER_UPDATE_EXIT_CODE, source: 'self-update', detail: `v${newVer}` });
        process.exit(RESTART_AFTER_UPDATE_EXIT_CODE);

      } else {
        process.stderr.write('请先配置更新源:\n');
        process.stderr.write('  hyacinth update --repo <owner/name>  (远程)\n');
        process.stderr.write('  hyacinth update --source <path>       (本地)\n');
        process.exit(1);
      }
    });

  // 守护进程（默认启用）：Agent 退出(code 42)时自动重新拉起
  // 子进程通过 GUARDIAN_ENV 环境变量避免递归
  const noGuardian = process.argv.includes('--no-guardian');
  process.argv = process.argv.filter(a => a !== '--no-guardian');
  if (!noGuardian && !process.env[GUARDIAN_ENV]) {
    const { runGuardian } = await import('../supervisor/guardian.js');
    runGuardian(process.argv.slice(2));
    return;
  }

  program.parse();
}

/**
 * 执行 CLI 动作
 */
async function executeAction(
  prompt: string | undefined,
  options: Record<string, unknown>,
): Promise<void> {
  // 解析选项（let 允许向导覆盖）
  const _options = options as Record<string, unknown>;
  let providerType = options.provider as ProviderType | undefined;
  let modelName = options.model as string | undefined;
  let maxTurns = parseInt(options.maxTurns as string, 10) || getDefaultConfig().session.maxTurns;
  let maxContext = parseInt(options.maxContext as string, 10) || DEFAULT_MAX_CONTEXT_TOKENS;
  const maxMessages = parseInt(options.maxMessages as string, 10) || 10000;
  // 新 session 标记（/new 命令或在重启前写入）
  const newSessionFlag = path.join(os.homedir(), '.agent', '.new-session');
  const forceNewSession = fsSync.existsSync(newSessionFlag);
  if (forceNewSession) fsSync.unlinkSync(newSessionFlag);

  // 指定 session 恢复（/session <id>/load 写入）
  const resumeFile = path.join(os.homedir(), '.agent', '.resume-session');
  let resumeSessionId: string | undefined = fsSync.existsSync(resumeFile)
    ? (() => { const id = fsSync.readFileSync(resumeFile, 'utf-8').trim(); fsSync.unlinkSync(resumeFile); return id; })()
    : undefined;

  // 重启恢复：检查 .restart-session（/restart 写入）
  // 格式优先级：
  //   1. JSON 快照 {"channel": "sessionId", ...} —— RestartTool 多渠道快照（当前版本）
  //   2. "channel:sessionId" —— 旧格式（单渠道）
  //   3. 'true' —— 无渠道信息（继续最近）
  // 渠道隔离：仅当快照包含当前启动渠道时才恢复对应 session；否则忽略特定 session，
  // 走 shouldContinue（由 factory 按当前渠道恢复最近 session）。
  // 统一策略：非 TUI 启动（launchChannel 为空）一律不恢复特定 session——
  // 因为 .restart-session 只服务于渠道感知的 TUI 恢复，CLI/服务模式恢复最近即可，
  // 避免把其他渠道（如飞书）的 session 恢复给 CLI 交互。
  let restartSessionId: string | undefined;
  let restartContinue = false;
  // 当前启动渠道（决定「按渠道恢复」「按渠道注入」用哪个键）：TUI 模式 = 'tui'。
  // 必须与 TUI 的 loop 实际使用的渠道一致：TUI 的 loop 由 ui-protocol-session 创建，
  // 其渠道由**调用方**给出（tui.ts 传 'tui'；浏览器 WebUI 走缺省 'webui'）。
  // 不一致的后果（0.9.56 曾把两侧写成 'tui' 而 ui-protocol 硬编码 'webui'）：
  //   ① 快照键取不到本会话（`snapshot['tui']` 恒缺）→ 连 /session 显式切过的会话都会丢；
  //   ② 续工指令被判「渠道不符」而搁置（用户自己发起的 TUI 重启反而收不到续工）。
  const launchChannel = options.tui ? 'tui' : undefined;
  // 防陈旧：崩溃残留的 marker 不应让下次正常启动误入旧会话。
  // 超过 10 分钟的 marker 视为陈旧 → 直接删除并按无 marker 处理。
  const RESTART_MARKER_MAX_AGE_MS = 10 * 60 * 1000;
  const content = markerIsFresh(RESTART_SESSION_MARKER, RESTART_MARKER_MAX_AGE_MS)
    ? consumeMarker(RESTART_SESSION_MARKER)
    : (removeMarker(RESTART_SESSION_MARKER), null);
  // 装载快照供**各渠道**取用（不再只有 TUI 这一条消费路径）：渠道启动时按自己的
  // 名字取回重启前的会话，实现「各渠道各自恢复」；无命中则回退本渠道最近会话。
  loadRestartSnapshot(content);
  if (content !== null) {
    restartContinue = true;
    // 非 TUI 模式：忽略特定 session，统一走 shouldContinue（恢复最近）
    if (content && content !== 'true' && launchChannel) {
      // 1) 尝试 JSON 多渠道快照
      let snapshot: Record<string, string> | null = null;
      try {
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          snapshot = parsed as Record<string, string>;
        }
      } catch { /* 非 JSON，走旧格式 */ }

      if (snapshot) {
        // 仅当快照包含当前启动渠道（tui）时才恢复；否则交给 factory 的 shouldContinue
        if (snapshot[launchChannel]) {
          restartSessionId = snapshot[launchChannel];
        }
      } else {
        // 2) 旧格式：channel:sessionId
        const sep = content.indexOf(':');
        if (sep > 0) {
          const restartChannel = content.slice(0, sep);
          const restartSid = content.slice(sep + 1);
          if (restartChannel === launchChannel) {
            restartSessionId = restartSid;
          }
        } else {
          restartSessionId = content;  // 3) 旧格式：纯 session ID，兼容
        }
      }
    }
  }

  const shouldContinue = forceNewSession
    ? false
    : options.continue as boolean | undefined || restartContinue;
  // 重启恢复的 session ID 仅在 resumeSessionId 为空时使用（低于 /session load 和 CLI --session）
  if (!resumeSessionId) resumeSessionId = restartSessionId;
  const sessionId = options.session as string | undefined || resumeSessionId;
  const interactive = options.interactive as boolean | undefined;
  let useTui = options.tui as boolean | undefined;
  const startModel = options.startModel as boolean | undefined;
  const skipSetup = options.skipSetup as boolean | undefined;
  const localModelName = options.localModel as string | undefined;

  // 加载 .env 中的 API Key
  const configManager = new ConfigManager(process.cwd());
  await configManager.loadEnvKeys();

  // 首次运行检测（除非 --skip-setup）
  if (!skipSetup && await configManager.isFirstRun()) {
    const result = await new SetupWizard().run();
    if (!result.config.provider) {
      return;
    }
    // 向导完成后重新加载配置，并覆盖 CLI 选项
    await configManager.loadEnvKeys();
    providerType = result.config.provider as ProviderType;
    modelName = result.config.model;
    maxContext = result.config.maxContext;
    if (result.enterTui) {
      useTui = true;
    }
  }

  // 初始化生命周期管理器
  const supervisor = new LifecycleSupervisor();
  const removeHandlers = supervisor.installSignalHandlers();
  // 全局子进程收割器 + 启动清扫孤儿 watchdog（详见 tui.ts 同处注释）
  installGlobalReaper();
  void import('../mcp/orphan-sweeper.js').then(({ sweepOrphanedWatchdogs }) =>
    sweepOrphanedWatchdogs().catch(() => {}),
  );
  let loop: any;
  let sessionDir: string;

  try {
    // 如果指定了 --provider local, 自动启动本地模型
    let finalProviderType = providerType;
    let finalModelName = modelName;

    // 如果没有通过 CLI 指定 provider/model，从 config.json 读取上次 /provider 命令保存的值
    if (!finalProviderType || !finalModelName) {
      try {
        const savedConfig = await configManager.load();
        const rawProvider = savedConfig.provider as unknown;
        if (!finalProviderType && rawProvider) {
          if (typeof rawProvider === 'object' && rawProvider !== null && 'active' in rawProvider) {
            finalProviderType = (rawProvider as { active: string }).active as ProviderType;
          } else if (typeof rawProvider === 'string') {
            finalProviderType = rawProvider as ProviderType;
          }
        }
        if (!finalModelName) {
          if (typeof rawProvider === 'object' && rawProvider !== null && 'active' in rawProvider) {
            const activeKey = (rawProvider as { active: string }).active;
            const providerSection = (rawProvider as Record<string, unknown>)[activeKey];
            if (providerSection && typeof providerSection === 'object' && 'model' in providerSection) {
              finalModelName = (providerSection as { model: string }).model;
            }
          } else if (typeof savedConfig.model === 'string' && savedConfig.model) {
            finalModelName = savedConfig.model;
          }
        }
      } catch {
        // config.json 不存在或格式错误，使用默认值
      }
    }

    if (providerType === 'local') {
      // 同步取注册表首个 enabled 模型名（不 spawn 进程），供 createProvider 使用
      if (!finalModelName) {
        try {
          finalModelName = supervisor.getFirstEnabledModelName(process.cwd()) ?? undefined;
        } catch {
          // 注册表不可用时保持默认
        }
      }
    } else if (startModel) {
      const models = await supervisor.loadAndStartModels(process.cwd());

      if (models.length > 0) {
        const model = models[0]; // 使用第一个可用模型
        finalModelName = model.modelName;
        logger.info(
          'Local model started',
          { model: model.name, backend: model.backend, baseUrl: model.baseUrl, modelName: model.modelName },
        );
      }
    }

    // 创建 Provider
    getProviderConfigLoader(process.cwd());
    const provider = await createProvider(finalProviderType, finalModelName);

    // 异步拉起本地模型：不阻塞进入 TUI；ready 后自动挂载到 provider。
    // （幂等：LocalModelModule 单例共享 bridge，重复调用不会重复 spawn）
    if (providerType === 'local') {
      void (async () => {
        try {
          const models = await supervisor.loadAndStartModels(process.cwd());
          if (models.length > 0) {
            const model = models[0];
            if (provider.getProviderType() === 'local') {
              (provider as LocalProvider).setBaseUrl(model.baseUrl);
              (provider as LocalProvider).setModel(model.modelName);
            }
            logger.info(
              'Local model started (async)',
              { model: model.name, backend: model.backend, baseUrl: model.baseUrl, modelName: model.modelName },
            );
          }
        } catch (error: unknown) {
          logger.warn('Local model start failed (async)', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    // 动态获取 maxContext：如果用户未指定，从模型目录读取
    if (!options.maxContext) {
      maxContext = getModelContextWindow(provider.getProviderType(), provider.getModel());
    }

    // 如果是 local provider，将已启动的模型 URL 和 model 注入
    let localModelProvider: Provider | undefined;
    if (provider.getProviderType() === 'local' && supervisor.getRunningModels().length > 0) {
      const modelInfo = supervisor.getRunningModels()[0];
      (provider as LocalProvider).setBaseUrl(modelInfo.baseUrl);
      (provider as LocalProvider).setModel(modelInfo.modelName);
    }

    // 如果指定了 --local-model，为压缩通道创建独立本地 Provider
    if (localModelName) {
      try {
        localModelProvider = await createProvider('local', localModelName);
        logger.info('Local model for compression', { model: localModelName });
      } catch {
        logger.warn('Failed to create local model provider for compression, using main provider');
      }
    }

    // 显示启动信息
    logger.info(
      'Provider ready',
      { provider: provider.getProviderType(), model: provider.getModel() },
    );

    // 显示受管进程状态
    const allStatus = supervisor.getAllStatus();
    if (allStatus.length > 0) {
      for (const s of allStatus) {
        logger.info('Managed process status', { name: s.name, state: s.state, type: s.type });
      }
    }

    // TUI mode — use blessed full-screen UI
    if (useTui) {
      // 检测重启续工指令（TUI 模式下需在进入前读取）
      // 按渠道判定：指令若属于别的渠道（如微信），**不消费** —— 原样留待对应启动模式接手，
      // 否则会把别渠道的上下文注入本渠道会话（2026-09-17 串台事故的直接成因）。
      let continuationMessage: string | undefined;
      const continuation = takeRestartContinuation({ launchChannel, sessionId });
      if (continuation.skippedChannel) {
        process.stderr.write(
          `[hyacinth] 重启续工指令属于渠道 "${continuation.skippedChannel}"，本次启动渠道不同 —— 保留待其接手\n`,
        );
      }
      continuationMessage = continuation.message;
      await runTui(
        provider,
        sessionId,
        shouldContinue ?? false,
        maxTurns,
        maxContext,
        maxMessages,
        skipSetup,
        DEFAULT_PERSONA_DIR,
        localModelProvider,
        continuationMessage,
      );
      return;
    }

    // Session + 模块初始化（由工厂统一处理）
    // 会话归属渠道：会话落 `<channel>_` 前缀（供识别来源 / 按渠道隔离恢复），
    // 并**注册该前缀**使 sessionId 能反查渠道 —— 注册式：核心不预置任何渠道前缀。
    //
    // TUI 模式下**本分支不会走到**（1422 行已 return，loop 交给 runTui/ui-protocol 创建），
    // 这里给 TUI 注册 'tui_' 只为让**存量** tui_ 会话仍能反解出渠道（历史兼容）。
    // TUI 实际的**会话归属渠道是 'webui'**（ui-protocol-session 传 channel:'webui'，
    // tui.ts 的 factory 原样透传），与上面 launchChannel 的取值同源 —— 两者必须一致：
    // 不一致则重启快照键取不到本会话、续工指令也会被判「渠道不符」而搁置（见 launchChannel 注释）。
    // 历史事故：TUI / WebUI / 微信三方被认领进同一份对话历史。
    const cliChannel = (options.channel as string | undefined)
      ?? (options.tui ? 'tui' : undefined);
    if (cliChannel) {
      const { registerChannelPrefixes } = await import('../session-channel.js');
      registerChannelPrefixes(`${cliChannel}_`, cliChannel);
    }

    const agentResult = await createAgent(
      {
        cwd: process.cwd(),
        provider,
        maxTurns,
        maxContext,
        outputHandler: createCliHandler(),
        sessionId,
        shouldContinue,
        maxMessages,
        localModelProvider,
        channel: cliChannel,
      },
      supervisor,
    );

    loop = agentResult.loop;
    sessionDir = agentResult.sessionDir;

    // 注入 LifecycleSupervisor，实现运行时 provider 切换时自动管理本地模型进程
    loop.setLifecycleSupervisor(supervisor);

    // 检测重启续工指令（与 TUI 模式同一策略：按渠道判定，不匹配则不消费、原样留待接手）
    if (!prompt) {
      const continuation = takeRestartContinuation({
        launchChannel,
        sessionId: path.basename(sessionDir),
      });
      if (continuation.skippedChannel) {
        process.stderr.write(
          `[hyacinth] 重启续工指令属于渠道 "${continuation.skippedChannel}"，本次启动渠道不同 —— 保留待其接手\n`,
        );
      }
      prompt = continuation.message;
    }

  // 决定运行模式
  if (prompt) {
    // 单次执行模式
    await loop.run(prompt);
  } else if (interactive || !prompt) {
    // 交互模式（默认进入交互模式）
    await runInteractive(loop);
  }
  } finally {
    await loop?.shutdown?.();
    await supervisor.shutdownAll();
    removeHandlers();
  }
}

/**
 * 创建 Provider 实例
 */
async function createProvider(providerType?: ProviderType, modelName?: string): Promise<ReturnType<ProviderManager['getProvider']>> {
  if (providerType) {
    // 显式指定 provider 类型
    try {
      const apiKey = getApiKeyForProvider(providerType);
      const config: ProviderConfig = {
        type: providerType,
        apiKey,
        model: modelName ?? getDefaultModel(providerType),
      };
      const manager = new ProviderManager(config);
      return manager.getProvider();
    } catch (err) {
      // 配置的 provider 不可用（缺少 API key 等），尝试自动检测
      logger.warn('Configured provider unavailable, trying auto-detection', {
        configured: providerType,
        reason: err instanceof Error ? err.message : String(err),
      });
      // 清空 modelName，因为它是针对不可用 provider 的
      modelName = undefined;

      // 先尝试 config.json 中其他有 API key 的 provider（而非 detectFromEnv 的硬编码优先级）
      try {
        const configPath = path.join(os.homedir(), '.agent', 'config.json');
        const raw = await fs.readFile(configPath, 'utf-8');
        const fullConfig = JSON.parse(raw);
        const pw = fullConfig?.provider;
        if (pw && typeof pw === 'object') {
          for (const [name, cfg] of Object.entries(pw)) {
            if (name === 'active' || name === 'routeMode') continue;
            if (name === providerType) continue;
            const c = cfg as Record<string, unknown>;
            const envName = c.apiKeyEnv as string | undefined;
            if (envName && process.env[envName]) {
              const newConfig: ProviderConfig = {
                type: name as ProviderType,
                apiKey: process.env[envName]!,
                model: (c.model as string) || getDefaultModel(name as ProviderType),
              };
              const manager = new ProviderManager(newConfig);
              logger.info('Auto-selected available provider from config', { provider: name, model: newConfig.model });
              return manager.getProvider();
            }
          }
        }
      } catch {
        // config.json 无法读取，继续走 detectFromEnv
      }

      // 回退到自动检测
    }
  }

  // 未显式指定 provider，优先从配置文件创建
  if (!modelName) {
    try {
      const manager = await ProviderManager.createFromConfigFile(undefined, process.cwd());
      return manager.getProvider();
    } catch {
      // 配置文件不存在或无效，回退到自动检测
    }
  }

  // 有 model 但没有 provider，尝试自动检测
  if (modelName) {
    const manager = new ProviderManager();
    const provider = manager.getProvider();
    // 如果指定了 model，需要创建新的配置
    const config: ProviderConfig = {
      type: provider.getProviderType(),
      apiKey: getApiKeyForProvider(provider.getProviderType()),
      model: modelName,
    };
    const newManager = new ProviderManager(config);
    return newManager.getProvider();
  }

  // 完全自动检测
  const manager = new ProviderManager();
  return manager.getProvider();
}

/**
 * 获取指定 Provider 的 API Key
 */
function getApiKeyForProvider(type: ProviderType): string {
  if (type === 'local') return 'local';

  // gemini 特殊处理：支持 GEMINI_API_KEY 或 GOOGLE_API_KEY
  if (type === 'gemini') {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required.');
    return key;
  }

  const envVarName = API_KEY_MAP[type];
  if (!envVarName) {
    throw new Error(`Unknown provider type: ${type as string}`);
  }

  const key = process.env[envVarName];
  if (!key) throw new Error(`${envVarName} is required.`);
  return key;
}

/**
 * 获取指定 Provider 的默认模型名称
 */
function getDefaultModel(type: ProviderType): string {
  // 优先从模型目录获取该 provider 的第一个「可用」模型 ID
  // （过滤 deprecated，防止退役模型被当作默认 → 必然 404/熔断）
  try {
    const entries = getModelCatalogLoader().getByProvider(type);
    const firstAvailable = entries.find((m) => m.id !== '__default__' && m.status !== 'deprecated');
    if (firstAvailable?.id) return firstAvailable.id;
  } catch { /* loader 未初始化时回退旧路径 */ }
  // 其次从 PROVIDER_MODELS 获取第一个模型 ID（兼容旧调用方）
  const models = PROVIDER_MODELS[type];
  if (models && models.length > 0) {
    return models[0].id;
  }
  // 再次从 provider config loader 读取默认模型
  const provCfg = getProviderConfigLoader().getProvider(type);
  if (provCfg?.defaultModel) return provCfg.defaultModel;
  // 最后按 provider 类型兜底
  switch (type) {
    case 'openrouter': return 'openrouter/auto';
    case 'gemini': return 'gemini-3.6-flash';
    case 'local': case 'llamacpp': return 'local';
    default: return 'unknown';
  }
}

/**
 * 交互模式 — 使用 readline 读取用户输入
 */
async function runInteractive(loop: AgentLoop): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  logger.info('Interactive mode. Type "exit" or "quit" to exit. Press Ctrl+C to interrupt.');

  // Ctrl+C 优雅退出
  let sigintCount = 0;
  const onSigInt = () => {
    sigintCount++;
    if (sigintCount >= 2) {
      // 第二次 Ctrl+C，直接退出
      logger.info('Exiting...');
      rl.close();
      process.exit(0);
    }
    // 第一次 Ctrl+C，提示
    logger.info('Press Ctrl+C again to exit, or type "exit".');
    rl.prompt();
  };
  process.on('SIGINT', onSigInt);

  return new Promise<void>((resolve) => {
    rl.prompt();

    rl.on('line', async (line: string) => {
      const input = line.trim();

      if (!input) {
        rl.prompt();
        return;
      }

      if (input === 'exit' || input === 'quit') {
        logger.info('Goodbye!');
        rl.close();
        return;
      }

      // 重置 SIGINT 计数
      sigintCount = 0;

      try {
        await loop.run(input);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Loop error', undefined, { error: message });
      }

      rl.prompt();
    });

    rl.on('close', () => {
      process.removeListener('SIGINT', onSigInt);
      resolve();
    });
  });
}


