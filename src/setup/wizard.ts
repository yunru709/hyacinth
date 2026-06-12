import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ConfigManager, type AgentConfig } from './config.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { getModelContextWindow, PROVIDER_MODELS } from './model-defaults.js';
import { ensurePersonaFiles, DEFAULT_PERSONA_DIR } from './persona-bootstrap.js';

/** Provider 选项 */
const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'claude-sonnet-4' },
  { value: 'openai', label: 'OpenAI (GPT)', hint: 'gpt-4o' },
  { value: 'deepseek', label: 'DeepSeek', hint: 'deepseek-v4' },
  { value: 'gemini', label: 'Google Gemini', hint: 'gemini-2.5-pro' },
  { value: 'groq', label: 'Groq', hint: 'llama-3.3' },
  { value: 'xai', label: 'xAI (Grok)', hint: 'grok-4' },
  { value: 'mistral', label: 'Mistral', hint: 'mistral-large' },
  { value: 'openrouter', label: 'OpenRouter', hint: 'multi-provider' },
  { value: 'moonshot', label: 'Moonshot (Kimi)', hint: 'kimi-k2' },
  { value: 'local', label: 'Local (OpenAI-compatible)', hint: 'localhost' },
];

/** Key 获取链接 */
const KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/apikey',
  groq: 'https://console.groq.com/keys',
  xai: 'https://console.x.ai',
  mistral: 'https://console.mistral.ai/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  moonshot: 'https://platform.moonshot.cn/console/api-keys',
};

/** 从 PROVIDER_MODELS 生成每个 provider 的模型选项 */
function buildModelOptions(provider: string): { value: string; label: string; hint: string }[] {
  const models = PROVIDER_MODELS[provider];
  if (!models || models.length === 0) return [];

  return models.map((m) => {
    const ctxK = m.contextWindow >= 1000000
      ? `${(m.contextWindow / 1000000).toFixed(1)}M`
      : m.contextWindow >= 1000
      ? `${Math.round(m.contextWindow / 1000)}K`
      : String(m.contextWindow);
    return {
      value: m.id,
      label: m.name,
      hint: `${ctxK} ctx`,
    };
  });
}

export interface SetupResult {
  config: AgentConfig;
  apiKey?: string;
  /** 用户是否选择完成后进入 TUI */
  enterTui: boolean;
}

export class SetupWizard {
  private configManager: ConfigManager;

  constructor() {
    this.configManager = new ConfigManager();
  }

  /** 运行完整向导 */
  async run(existingConfig?: AgentConfig): Promise<SetupResult> {
    p.intro(pc.bold(pc.cyan('Agent Setup Wizard')));

    if (existingConfig) {
      p.note(
        `Provider: ${existingConfig.provider}\nModel: ${existingConfig.model}`,
        '检测到已有配置',
      );
    }

    while (true) {
      // Step 1: Provider
      const provider = await this.stepProvider(existingConfig?.provider);
      if (p.isCancel(provider)) return this.cancel();

      // Step 2: API Key
      let apiKey: string | undefined;
      if (provider !== 'local') {
        const keyResult = await this.stepApiKey(provider as string);
        if (p.isCancel(keyResult)) return this.cancel();
        apiKey = keyResult as string;
      }

      // Step 2.5: llama.cpp setup (local provider only)
      if (provider === 'local') {
        const llamaResult = await this.stepLlamaCpp();
        if (p.isCancel(llamaResult)) return this.cancel();
      }

      // Step 3: Model
      const model = await this.stepModel(provider as string, existingConfig?.model);
      if (p.isCancel(model)) return this.cancel();

      // ▲ 根据模型自动计算推荐的 maxContext
      const recommendedCtx = getModelContextWindow(provider as string, model as string);
      const defaultCtx = existingConfig?.maxContext ?? recommendedCtx;

      // Step 4: maxContext
      const maxContext = await this.stepMaxContext(defaultCtx, recommendedCtx);
      if (p.isCancel(maxContext)) return this.cancel();

      // Step 5: Confirm
      const config: AgentConfig = {
        provider: provider as string,
        model: model as string,
        maxTurns: existingConfig?.maxTurns ?? getDefaultConfig().session.maxTurns,
        maxContext: maxContext as number,
      };

      const confirmed = await this.stepConfirm(config, apiKey);
      if (p.isCancel(confirmed)) return this.cancel();
      if (!confirmed) {
        p.log.warn('取消保存，重新开始...');
        continue;
      }

      // Save
      const s = p.spinner();
      s.start('正在保存配置...');

      try {
        await this.configManager.save(config);
        if (apiKey) {
          await this.configManager.saveApiKey(provider as string, apiKey);
        }
        s.stop(pc.green('配置已保存'));

        // 初始化 persona 文件
        const personaDir = DEFAULT_PERSONA_DIR;
        const ws = await ensurePersonaFiles(personaDir);
        if (ws.filesCreated.length > 0) {
          p.log.info(`已在 ${personaDir} 创建 ${ws.filesCreated.length} 个模板文件`);
        }
        if (ws.status === 'pending') {
          p.log.info(pc.cyan('首次启动时将进行个性化引导对话'));
        }
      } catch (error) {
        s.stop(pc.red('保存失败'));
        p.log.error(String(error));
        continue;
      }

      // Terminal Hatch: ask if user wants to enter TUI
      const enterTui = await p.confirm({
        message: '是否进入终端交互界面 (TUI)?',
        initialValue: true,
      });
      if (p.isCancel(enterTui)) return this.cancel();

      p.outro(pc.green('配置完成！'));

      return { config, apiKey, enterTui: enterTui as boolean };
    }
  }

  /** Step 1: Provider */
  private async stepProvider(defaultProvider?: string): Promise<string | symbol> {
    const initialValue = defaultProvider ?? 'anthropic';
    return p.select({
      message: '选择 AI 提供商',
      options: PROVIDERS.map(p => ({
        ...p,
        hint: p.value === initialValue ? `${p.hint} (当前)` : p.hint,
      })),
      initialValue,
    });
  }

  /** Step 2: API Key */
  private async stepApiKey(provider: string): Promise<string | undefined | symbol> {
    const keyUrl = KEY_URLS[provider];
    if (keyUrl) {
      p.note(keyUrl, '获取 API Key');
    }

    // 检查已有 Key
    const existingKey = process.env[this.configManager.getApiKeyEnvName(provider) ?? ''];
    if (existingKey) {
      const masked = existingKey.slice(0, 8) + '...' + existingKey.slice(-4);
      const keep = await p.confirm({
        message: `保留现有 Key? (${masked})`,
        initialValue: true,
      });
      if (p.isCancel(keep)) return keep as symbol;
      if (keep) return existingKey;
    }

    // 输入新 Key
    const key = await p.password({
      message: '请输入 API Key',
      validate(value) {
        if (!value) return 'Key 不能为空';
        if (provider === 'anthropic' && !value.startsWith('sk-ant-')) {
          return 'Anthropic Key 应以 sk-ant- 开头';
        }
        if (provider === 'openai' && !value.startsWith('sk-')) {
          return 'OpenAI Key 应以 sk- 开头';
        }
        return;
      },
    });

    return key;
  }

  /** Step 3: Model */
  private async stepModel(provider: string, defaultModel?: string): Promise<string | symbol> {
    const models = buildModelOptions(provider);
    if (!models || models.length === 0) {
      return p.text({
        message: '输入模型名称',
        placeholder: 'model-name',
        initialValue: defaultModel ?? '',
      });
    }

    const options = [
      ...models.map(m => ({ ...m })),
      { value: '__custom__', label: '自定义输入...', hint: '' },
    ];

    const selected = await p.select({
      message: '选择默认模型',
      options,
      initialValue: defaultModel ?? models[0].value,
    });

    if (p.isCancel(selected)) return selected;

    if (selected === '__custom__') {
      return p.text({
        message: '输入模型名称',
        placeholder: models[0].value,
        initialValue: '',
      });
    }

    return selected as string;
  }

  /** Step 4: maxContext — 自动根据模型推荐，允许修改 */
  private async stepMaxContext(
    defaultValue: number,
    recommended: number,
  ): Promise<number | symbol> {
    const ctxLabel = defaultValue >= 1_000_000
      ? `${(defaultValue / 1_000_000).toFixed(1)}M`
      : defaultValue >= 1000
      ? `${Math.round(defaultValue / 1000)}K`
      : String(defaultValue);

    const result = await p.text({
      message: `设置最大上下文窗口 (推荐 ${ctxLabel})`,
      placeholder: String(defaultValue),
      initialValue: String(defaultValue),
      validate(value) {
        const n = Number(value);
        if (!value || isNaN(n) || n < 1000) return '请输入有效的数字 (≥ 1000)';
        return;
      },
    });

    if (p.isCancel(result)) return result as symbol;

    return Number(result);
  }

  /** Step 5: Confirm */
  private async stepConfirm(config: AgentConfig, apiKey?: string): Promise<boolean | symbol> {
    const ctxDisplay = config.maxContext >= 1_000_000
      ? `${(config.maxContext / 1_000_000).toFixed(1)}M`
      : config.maxContext >= 1000
      ? `${Math.round(config.maxContext / 1000)}K`
      : String(config.maxContext);
    const lines = [
      `${pc.dim('Provider:')}    ${pc.bold(config.provider)}`,
      `${pc.dim('Model:')}       ${pc.bold(config.model)}`,
      `${pc.dim('Max Turns:')}   ${config.maxTurns}`,
      `${pc.dim('Max Context:')} ${ctxDisplay} (${config.maxContext.toLocaleString()} tokens)`,
      `${pc.dim('API Key:')}     ${apiKey ? pc.green('已设置') : pc.yellow('未设置')}`,
    ];

    p.note(lines.join('\n'), '确认配置');

    return p.confirm({
      message: '确认保存以上配置?',
      initialValue: true,
    });
  }

  /** Step 2.5: llama.cpp setup (local provider) */
  private async stepLlamaCpp(): Promise<string | symbol> {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const projectRoot = join(__dirname, '..', '..');
    const llamaCmake = join(projectRoot, 'libs', 'llama.cpp', 'CMakeLists.txt');

    if (existsSync(llamaCmake)) {
      p.log.info(pc.green('llama.cpp 已安装 ✓'));
      return this.stepModelDownload();
    }

    const choice = await p.select({
      message: '本地模型需要 llama.cpp 推理引擎，是否自动下载编译？',
      options: [
        { value: 'auto', label: '是，自动下载编译', hint: '推荐' },
        { value: 'installed', label: '我已安装（跳过）', hint: '使用系统 PATH 中的 llama-server' },
        { value: 'skip', label: '跳过，稍后手动执行', hint: 'npm run setup:llamacpp' },
      ],
      initialValue: 'auto',
    });

    if (p.isCancel(choice)) return choice;

    if (choice === 'auto') {
      const s = p.spinner();
      s.start('正在编译 llama.cpp（可能需要几分钟）...');

      try {
        await this.runSetupLlamaCpp(projectRoot);
        s.stop(pc.green('llama.cpp 编译完成 ✓'));
      } catch (err) {
        s.stop(pc.red('编译失败'));
        p.log.error(String(err));
        p.note(
          '请确认已安装 Git、CMake 和 Visual Studio Build Tools (MSVC)\n'
          + '也可稍后手动执行: npm run setup:llamacpp',
          '编译失败',
        );
        return this.stepModelDownload();
      }

      return this.stepModelDownload();
    }

    if (choice === 'installed') {
      p.log.info('将使用系统 PATH 中的 llama-server');
      return this.stepModelDownload();
    }

    p.log.info('可稍后执行: npm run setup:llamacpp');
    return this.stepModelDownload();
  }

  /** 执行 setup-llamacpp.ps1 并实时展示输出 */
  private runSetupLlamaCpp(projectRoot: string): Promise<void> {
    const scriptPath = join(projectRoot, 'scripts', 'setup-llamacpp.ps1');

    return new Promise((resolve, reject) => {
      const proc = spawn('powershell', [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let lastOutput = '';

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          lastOutput = text;
          p.log.info(pc.gray(text));
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          p.log.warn(pc.yellow(text));
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`setup-llamacpp.ps1 exited with code ${code}\n${lastOutput}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start setup-llamacpp.ps1: ${err.message}`));
      });
    });
  }

  /** Step 2.6: 模型文件下载引导 */
  private async stepModelDownload(): Promise<string | symbol> {
    const modelsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'models');

    const choice = await p.select({
      message: '下一步：下载 GGUF 模型文件到 models/ 目录',
      options: [
        {
          value: 'done',
          label: '我已下载好模型文件',
          hint: `放置到 ${modelsDir}/`,
        },
        {
          value: 'later',
          label: '稍后处理',
          hint: '跳过，先体验在线模型',
        },
      ],
      initialValue: 'done',
    });

    if (p.isCancel(choice)) return choice;

    p.note(
      `推荐模型: qwen2.5-7b-instruct (推荐)\n`
      + `下载地址: https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF\n`
      + `存放路径: ${modelsDir}/\n\n`
      + `其他推荐模型:\n`
      + `  - llama-3.2-3b-instruct: https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF\n`
      + `  - deepseek-coder-1.3b: https://huggingface.co/unsloth/DeepSeek-Coder-V2-Lite-Instruct-GGUF`,
      '模型下载指引',
    );

    return choice;
  }

  /** 用户取消时的处理 */
  private cancel(): SetupResult {
    p.outro(pc.yellow('配置已取消'));
    return {
      config: {} as AgentConfig,
      apiKey: undefined,
      enterTui: false,
    };
  }
}
