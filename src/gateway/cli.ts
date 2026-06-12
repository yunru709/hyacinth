import readline from 'node:readline';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { LifecycleSupervisor } from '../lifecycle/index.js';
import { runTui } from './tui.js';
import { createAgent, createTrainingPipeline } from './factory.js';
import { ConfigManager, API_KEY_MAP, DEFAULT_MAX_CONTEXT_TOKENS } from '../setup/config.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { SetupWizard } from '../setup/wizard.js';
import { PROVIDER_MODELS } from '../setup/model-defaults.js';
import { DEFAULT_PERSONA_DIR, ensurePersonaFiles, getBootstrapStatus } from '../setup/persona-bootstrap.js';
import type { BootstrapStatus } from '../setup/persona-bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { getDefaultConfig } from '../runtime/defaults.js';
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
    onPermissionRequest(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always'> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      return new Promise((resolve) => {
        const inputStr = Object.entries(input)
          .map(([k, v]) => `${k}=${String(v).substring(0, 60)}`)
          .join(', ');
        process.stdout.write(
          chalk.yellow(`\n[Permission] ${toolName}(${inputStr}) - [Y]es/[A]lways/[N]o? `),
        );
        rl.question('', (answer: string) => {
          rl.close();
          const lower = answer.toLowerCase();
          if (lower === 'y' || lower === 'yes') resolve('yes');
          else if (lower === 'a' || lower === 'always') resolve('always');
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
    .name('deepthink')
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
      const bootstrapStatus = await getBootstrapStatus(personaDir);

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
          bootstrapStatus,
        });
      }
    });

  // doctor 子命令
  program
    .command('doctor')
    .description('系统诊断 + 自动修复 (System diagnostics & auto-fix)')
    .option('--fix', '自动修复检测到的问题')
    .option('--prompts', '显示原始 Persona 提示词')
    .action(async (options: { fix?: boolean; prompts?: boolean }) => {
      const { runDoctor } = await import('../cli/doctor.js');
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

  // serve 子命令
  program
    .command('serve')
    .description('启动 HTTP API 服务器 (Start HTTP API server)')
    .option('-p, --port <port>', '服务器端口', '3000')
    .option('--api-key <key>', 'API 认证密钥（或设置 DEEPTHINK_API_KEY 环境变量）')
    .option('--cors-origin <origin>', 'CORS 允许的域名（默认 *）')
    .option('--provider <type>', 'Provider 类型')
    .option('--model <name>', '模型名称')
        .option('--max-turns <n>', '轮次统计上限', '100')
    .option('--max-context <tokens>', '最大上下文 Token', String(DEFAULT_MAX_CONTEXT_TOKENS))
    .action(async (options: Record<string, string>) => {
      const { startServer } = await import('./server.js');
      const port = parseInt(options.port, 10);
      const { manager } = await startServer({
        port,
        cwd: process.cwd(),
        provider: options.provider,
        model: options.model,
        maxTurns: parseInt(options.maxTurns, 10),
        maxContext: parseInt(options.maxContext, 10),
        apiKey: options.apiKey,
        corsOrigin: options.corsOrigin,
      });

      const shutdown = async () => {
        console.log('\nShutting down...');
        await manager.stopAll();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
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
      const projectKey = toProjectKey(options.project);
      const sessionManager = new SessionManager(projectKey);
      const sessionDir = sessionManager.getSessionDir(sessionId);

      try {
        await fs.access(sessionDir);
      } catch {
        logger.error('Session not found', undefined, { sessionId });
        process.exit(1);
      }

      await fs.rm(sessionDir, { recursive: true, force: true });
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

  configCmd
    .command('get [path]')
    .description('Get a config value by dot-path, or the full config if no path given')
    .action(async (path?: string) => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      if (path) {
        const val = getByPath(cfg as unknown as Record<string, unknown>, path);
        process.stdout.write(JSON.stringify(val, null, 2) + '\n');
      } else {
        process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
      }
    });

  configCmd
    .command('set <path> <value>')
    .description('Set a config value by dot-path and save (changes take effect on next restart)')
    .action(async (path: string, value: string) => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      const parsed = parseValue(value);
      setByPath(cfg as unknown as Record<string, unknown>, path, parsed);
      await cm.save(cfg);
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
      const defaults = getDefaultConfig() as unknown as Record<string, unknown>;

      if (path) {
        // Reset single path
        const cfg = await cm.load();
        const defaultVal = getByPath(defaults, path);
        setByPath(cfg as unknown as Record<string, unknown>, path, defaultVal);
        await cm.save(cfg);
        logger.info('Config path reset to default', { path, defaultValue: defaultVal });
      } else {
        // Reset everything
        await cm.save(defaults as unknown as Parameters<ConfigManager['save']>[0]);
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

      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      cfg.provider = provider;
      cfg.model = models[0].id;
      await cm.save(cfg);
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
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      logger.info('Current provider', { provider: cfg.provider, model: cfg.model });

      const models = PROVIDER_MODELS[cfg.provider];
      if (models) {
        const current = models.find((m) => m.id === cfg.model);
        if (current) {
          logger.info('Model details', {
            name: current.name,
            contextWindow: current.contextWindow,
            maxTokens: current.maxTokens,
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
    .description('Enable a skill (writes to config, takes effect on next restart)')
    .action(async (name: string) => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;

      const skills: Record<string, boolean> = (cfg.skills as Record<string, boolean>) ?? {};
      skills[name] = true;
      cfg.skills = skills;
      await cm.save(cfg as unknown as Parameters<ConfigManager['save']>[0]);
      logger.info('Skill enabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  skillCmd
    .command('disable <name>')
    .description('Disable a skill (writes to config, takes effect on next restart)')
    .action(async (name: string) => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;

      const skills: Record<string, boolean> = (cfg.skills as Record<string, boolean>) ?? {};
      skills[name] = false;
      cfg.skills = skills;
      await cm.save(cfg as unknown as Parameters<ConfigManager['save']>[0]);
      logger.info('Skill disabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  skillCmd
    .command('list')
    .description('List all skills with enabled/disabled status')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;
      const skills: Record<string, boolean> = (cfg.skills as Record<string, boolean>) ?? {};

      if (Object.keys(skills).length === 0) {
        logger.info('No skills configured. Use "agent skill enable <name>" to add one.');
        return;
      }

      for (const [name, enabled] of Object.entries(skills)) {
        const status = enabled ? chalk.green('enabled') : chalk.gray('disabled');
        process.stdout.write(`${chalk.bold(name)} ${status}\n`);
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
    .description('Enable a tool (writes to config, takes effect on next restart)')
    .action(async (name: string) => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;

      const tools: Record<string, boolean> = (cfg.tools as Record<string, boolean>) ?? {};
      tools[name] = true;
      cfg.tools = tools;
      await cm.save(cfg as unknown as Parameters<ConfigManager['save']>[0]);
      logger.info('Tool enabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  toolCmd
    .command('disable <name>')
    .description('Disable a tool (writes to config, takes effect on next restart)')
    .action(async (name: string) => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;

      const tools: Record<string, boolean> = (cfg.tools as Record<string, boolean>) ?? {};
      tools[name] = false;
      cfg.tools = tools;
      await cm.save(cfg as unknown as Parameters<ConfigManager['save']>[0]);
      logger.info('Tool disabled', { name });
      logger.info('Changes will take effect on next restart.');
    });

  toolCmd
    .command('list')
    .description('List all tools with enabled/disabled status')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load() as unknown as Record<string, unknown>;
      const tools: Record<string, boolean> = (cfg.tools as Record<string, boolean>) ?? {};

      if (Object.keys(tools).length === 0) {
        logger.info('No tools configured. Use "agent tool enable <name>" to add one.');
        return;
      }

      for (const [name, enabled] of Object.entries(tools)) {
        const status = enabled ? chalk.green('enabled') : chalk.gray('disabled');
        process.stdout.write(`${chalk.bold(name)} ${status}\n`);
      }
    });

  toolCmd.action(() => {
    toolCmd.outputHelp();
  });

  // ============================================================
  // train group: agent train on/off/now/status/cancel/schedule
  // ============================================================
  const trainCmd = program
    .command('train')
    .description('Manage training operations');

  trainCmd
    .command('on')
    .description('Enable automatic training')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      if (!cfg.training) {
        cfg.training = { enabled: true, scheduleTime: '03:00', checkIntervalMs: 600000, minSamples: 10, baseModel: 'models/llama-3-8b-q4_k_m.gguf' };
      } else {
        cfg.training.enabled = true;
      }
      await cm.save(cfg);
      logger.info('Training enabled.');
    });

  trainCmd
    .command('off')
    .description('Disable automatic training')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      if (cfg.training) {
        cfg.training.enabled = false;
      }
      await cm.save(cfg);
      logger.info('Training disabled.');
    });

  trainCmd
    .command('now')
    .description('Trigger training immediately')
    .action(async () => {
      const cwd = process.cwd();
      const cm = new ConfigManager(cwd);
      const cfg = await cm.load();

      logger.info('Training config', {
        enabled: cfg.training?.enabled ?? false,
        scheduleTime: cfg.training?.scheduleTime ?? 'not set',
        minSamples: cfg.training?.minSamples ?? 10,
      });

      if (!cfg.provider) {
        logger.error('No provider configured. Run "deepthink setup" first.');
        process.exit(1);
      }

      try {
        const providerType = cfg.provider as ProviderType;
        const apiKey = process.env[API_KEY_MAP[providerType]] ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
        const { ProviderManager } = await import('../provider/manager.js');
        const manager = new ProviderManager({
          type: providerType,
          apiKey: apiKey ?? 'local',
          model: cfg.model ?? getProviderConfigLoader().getProvider(providerType)?.defaultModel ?? 'unknown',
        });
        const provider = manager.getProvider();

        const sessionManager = new SessionManager(cwd);
        const session = await sessionManager.create();
        const sessionDir = sessionManager.getSessionDir(session.id);

        const statsManager = new StatsManager();

        const { trainingScheduler } = await createTrainingPipeline({
          cwd,
          sessionDir,
          statsManager,
          provider,
          config: cfg,
        });

        logger.info('Starting training...');
        const result = await trainingScheduler.triggerNow();
        logger.info('Training completed', {
          status: result.run.status,
          sampleCount: result.run.sampleCount,
          summary: result.summary,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Training failed', undefined, { error: message });
        process.exit(1);
      }
    });

  trainCmd
    .command('status')
    .description('Show training status')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      logger.info('Training status', {
        enabled: cfg.training?.enabled ?? false,
        scheduleTime: cfg.training?.scheduleTime ?? 'not set',
        checkIntervalMs: cfg.training?.checkIntervalMs ?? 600000,
        minSamples: cfg.training?.minSamples ?? 10,
        baseModel: cfg.training?.baseModel ?? 'not set',
      });
    });

  trainCmd
    .command('cancel')
    .description('Cancel ongoing training (disables training)')
    .action(async () => {
      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      if (cfg.training) {
        cfg.training.enabled = false;
      }
      await cm.save(cfg);
      logger.info('Training cancelled (disabled).');
    });

  trainCmd
    .command('schedule <HH:MM>')
    .description('Set training schedule time (24h format, e.g. 03:00)')
    .action(async (time: string) => {
      // Validate HH:MM format
      if (!/^(0\d|1\d|2[0-3]):([0-5]\d)$/.test(time)) {
        logger.error('Invalid time format. Use HH:MM (e.g., 03:00).');
        process.exit(1);
      }
      const [hh, mm] = time.split(':').map(Number);

      const cm = new ConfigManager(process.cwd());
      const cfg = await cm.load();
      if (!cfg.training) {
        cfg.training = { enabled: false, scheduleTime: time, checkIntervalMs: 600000, minSamples: 10, baseModel: 'models/llama-3-8b-q4_k_m.gguf' };
      } else {
        cfg.training.scheduleTime = time;
      }
      await cm.save(cfg);
      logger.info('Training schedule updated', { scheduleTime: time });
    });

  trainCmd.action(() => {
    trainCmd.outputHelp();
  });

  program
    .command('update')
    .description('Update deepthink from GitHub releases or local source')
    .option('--repo <owner/name>', 'GitHub repo, e.g. yunru709/deepthink')
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

        const tmpDir = p.join(os.tmpdir(), `deepthink-update-${Date.now()}`);
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
        process.stderr.write(`[update] ✅ 已更新到 v${version.latest}。重开 TUI 即可。\n`);

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
        process.stderr.write(`[update] ✅ 已更新到 v${newVer}。重开 TUI 即可。\n`);

      } else {
        process.stderr.write('请先配置更新源:\n');
        process.stderr.write('  deepthink update --repo <owner/name>  (远程)\n');
        process.stderr.write('  deepthink update --source <path>       (本地)\n');
        process.exit(1);
      }
    });

  // 守护进程（默认启用）：Agent 退出(code 42)时自动重新拉起
  // 子进程通过 DEEPTHINK_GUARDIAN_CHILD 环境变量避免递归
  const noGuardian = process.argv.includes('--no-guardian');
  if (!noGuardian && !process.env.DEEPTHINK_GUARDIAN_CHILD) {
    process.argv = process.argv.filter(a => a !== '--no-guardian');
    const { runGuardian } = await import('./guardian.js');
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
  const newSessionFlag = path.join(process.cwd(), '.agent', '.new-session');
  const forceNewSession = fsSync.existsSync(newSessionFlag);
  if (forceNewSession) fsSync.unlinkSync(newSessionFlag);

  // 指定 session 恢复（/session <id>/load 写入）
  const resumeFile = path.join(process.cwd(), '.agent', '.resume-session');
  const resumeSessionId = fsSync.existsSync(resumeFile)
    ? (() => { const id = fsSync.readFileSync(resumeFile, 'utf-8').trim(); fsSync.unlinkSync(resumeFile); return id; })()
    : undefined;

  const shouldContinue = forceNewSession
    ? false
    : options.continue as boolean | undefined
      || (() => {
        const restartFile = path.join(process.cwd(), '.agent', '.restart-session');
        if (fsSync.existsSync(restartFile)) {
          fsSync.unlinkSync(restartFile);
          return true;
        }
        return false;
      })();
  const sessionId = options.session as string | undefined || resumeSessionId;
  const interactive = options.interactive as boolean | undefined;
  let useTui = options.tui as boolean | undefined;
  const startModel = options.startModel as boolean | undefined;
  const skipSetup = options.skipSetup as boolean | undefined;
  const localModelName = options.localModel as string | undefined;
  const bootstrapStatus = options.bootstrapStatus as BootstrapStatus | undefined;

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

    if (providerType === 'local' || startModel) {
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

    // 动态获取 maxContext：如果用户未指定，从模型目录读取
    if (!options.maxContext) {
      maxContext = getModelContextWindow(provider.getProviderType(), provider.getModel());
    }

    // 如果是 local provider，将已启动的模型 URL 和 model 注入
    let localModelProvider: Provider | undefined;
    if (provider.getProviderType() === 'local' && supervisor.getModelManager().getModels().length > 0) {
      const modelInfo = supervisor.getModelManager().getModels()[0];
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
      let continuationMessage: string | undefined;
      const continuationFile = path.join(process.cwd(), '.agent', '.restart-continuation');
      if (fsSync.existsSync(continuationFile)) {
        continuationMessage = fsSync.readFileSync(continuationFile, 'utf-8').trim() || undefined;
        fsSync.unlinkSync(continuationFile);
      }
      await runTui(
        provider,
        sessionId,
        shouldContinue ?? false,
        maxTurns,
        maxContext,
        maxMessages,
        skipSetup,
        DEFAULT_PERSONA_DIR,
        bootstrapStatus,
        localModelProvider,
        continuationMessage,
      );
      return;
    }

    // Session + 模块初始化（由工厂统一处理）
    const { loop, sessionDir } = await createAgent(
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
      },
      supervisor,
    );

    // 注入 LifecycleSupervisor，实现运行时 provider 切换时自动管理本地模型进程
    loop.setLifecycleSupervisor(supervisor);

    if (loop.isBootstrapPending()) {
      await loop.startBootstrap();
    }

    // 检测重启续工指令
    if (!prompt) {
      const continuationFile = path.join(process.cwd(), '.agent', '.restart-continuation');
      if (fsSync.existsSync(continuationFile)) {
        prompt = fsSync.readFileSync(continuationFile, 'utf-8').trim() || undefined;
        fsSync.unlinkSync(continuationFile);
      }
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
  // 优先从 PROVIDER_MODELS 获取该 provider 的第一个模型 ID
  const models = PROVIDER_MODELS[type];
  if (models && models.length > 0) {
    return models[0].id;
  }
  // 其次从 provider config loader 读取默认模型
  const provCfg = getProviderConfigLoader().getProvider(type);
  if (provCfg?.defaultModel) return provCfg.defaultModel;
  // 最后按 provider 类型兜底
  switch (type) {
    case 'openrouter': return 'openrouter/auto';
    case 'gemini': return 'gemini-2.5-flash';
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
