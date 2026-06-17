/**
 * Command Registry — 统一斜杠命令注册中心
 *
 * 命令来源：
 *   1. BUILTIN — 内置命令（硬编码兜底）
 *   2. USER — commands.json（用户/模型可写，热重载）
 *
 * 合并规则：同名命令 USER 覆盖 BUILTIN
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('command-registry');

// ─── Types ─────────────────────────────────────────────────────────

export type SlashCommandCategory = 'session' | 'model' | 'tools' | 'system' | 'config' | 'repair' | 'mode';

export interface SlashCommandDef {
  name: string;
  description: string;
  icon: string;
  category: SlashCommandCategory;
  args?: string;
  argOptions?: string[];
  executeLocal?: boolean;
  /** 二级子命令（有 children 的命令在 TUI 中弹出选择面板而非直接执行） */
  children?: SlashCommandDef[];
  /** 动态子命令提供者（返回 Promise，在面板打开时调用。优先于 children） */
  childrenProvider?: () => Promise<SlashCommandDef[]>;
  /** 标记为已弃用（在 /help 中灰色显示） */
  deprecated?: boolean;
  /** 命令处理器（格式：module.method，如 localModel.start） */
  handler?: string;
}

/** commands.json 文件格式 */
interface CommandsConfig {
  commands: SlashCommandDef[];
}

// ─── Category Labels ────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  system: '系统',
  session: '会话',
  model: '模型',
  tools: '工具',
  config: '配置',
  repair: '修复',
  mode: '模式',
};

// ─── Builtin Commands ───────────────────────────────────────────────

const BUILTIN_COMMANDS: SlashCommandDef[] = [
  {
    name: 'help',
    description: '显示帮助信息',
    icon: '?',
    category: 'system',
    executeLocal: true,
  },
  {
    name: 'session',
    description: '会话管理 — 最近会话 / 新建 / 列表',
    icon: '◉',
    category: 'session',
    executeLocal: true,
    childrenProvider: async () => {
      const { SessionManager } = await import('../memory/session.js');
      const sm = new SessionManager(process.cwd());
      const all = await sm.list();
      const recent = all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 5);

      const children: SlashCommandDef[] = [
        { name: 'new', description: '创建新会话', icon: '＋', category: 'session', executeLocal: true },
      ];

      if (recent.length > 0) {
        children.push({
          name: '── 最近会话 ──',
          description: '展开查看操作',
          icon: ' ',
          category: 'session',
          executeLocal: true,
          children: [],
        } as SlashCommandDef);
      }

      for (const s of recent) {
        const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        children.push({
          name: s.id,
          description: `Session — ${date}`,
          icon: '📂',
          category: 'session',
          executeLocal: true,
          children: [
            { name: 'load', description: '加载会话', icon: '↻', category: 'session', args: s.id, executeLocal: true },
            { name: 'delete', description: '删除会话', icon: '✕', category: 'session', args: s.id, executeLocal: true },
          ],
        });
      }

      children.push(
        { name: '── 全部 ──', description: '查看所有会话', icon: ' ', category: 'session', executeLocal: true, children: [] } as SlashCommandDef,
        { name: 'list', description: '列出所有会话', icon: '☰', category: 'session', executeLocal: true },
      );

      return children;
    },
  },
  {
    name: 'clear',
    description: '清屏',
    icon: '\u2327',
    category: 'system',
    executeLocal: true,
  },
  {
    name: 'exit',
    description: '退出 Agent',
    icon: '\u2715',
    category: 'system',
    executeLocal: true,
  },
  {
    name: 'restart',
    description: '重启 Agent（自动恢复当前会话）',
    icon: '↻',
    category: 'system',
    executeLocal: true,
  },
  {
    name: 'new',
    description: '创建新会话',
    icon: '＋',
    category: 'session',
    executeLocal: true,
  },
  {
    name: 'status',
    description: '显示当前状态和配置',
    icon: '\u25CF',
    category: 'system',
    executeLocal: true,
  },
  {
    name: 'workflows',
    description: '列出所有可用工作流（Plan/Spec/TODO 及自定义）',
    icon: '\u{1F4CB}',
    category: 'mode',
    executeLocal: true,
  },
  {
    name: 'workflow',
    description: '工作流管理（激活/停止/状态/创建/删除）',
    icon: '\u{1F504}',
    category: 'mode',
    args: '<name|stop|status|create|delete>',
    executeLocal: true,
  },
  {
    name: 'done',
    description: '停用当前模式',
    icon: '\u2714',
    category: 'mode',
    executeLocal: true,
  },
  {
    name: 'model',
    description: '模型管理（在线/本地/设置/信息）',
    icon: '\u25C6',
    category: 'model',
    executeLocal: true,
    children: [
      {
        name: 'online',
        description: '切换在线模型...',
        icon: '\u{1F310}',
        category: 'model',
        children: [
          {
            name: 'anthropic',
            description: 'Anthropic (Claude)',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'claude-sonnet-4', description: '切换至 Claude Sonnet 4', icon: '\u25C6', category: 'model' },
              { name: 'claude-opus-4', description: '切换至 Claude Opus 4', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'openai',
            description: 'OpenAI',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'gpt-4o', description: '切换至 GPT-4o', icon: '\u25C6', category: 'model' },
              { name: 'gpt-4.1', description: '切换至 GPT-4.1', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'deepseek',
            description: 'DeepSeek',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'deepseek-v4-pro', description: '切换至 DeepSeek V4 Pro (1M上下文)', icon: '\u25C6', category: 'model' },
              { name: 'deepseek-v4-flash', description: '切换至 DeepSeek V4 Flash (1M上下文)', icon: '\u25C6', category: 'model' },
              { name: 'deepseek-chat', description: '切换至 DeepSeek Chat (即将退役)', icon: '\u25CB', category: 'model' },
              { name: 'deepseek-reasoner', description: '切换至 DeepSeek Reasoner (即将退役)', icon: '\u25CB', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'gemini',
            description: 'Gemini',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'gemini-2.5-pro', description: '切换至 Gemini 2.5 Pro', icon: '\u25C6', category: 'model' },
              { name: 'gemini-2.5-flash', description: '切换至 Gemini 2.5 Flash', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'groq',
            description: 'Groq',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'llama-4-maverick', description: '切换至 Llama 4 Maverick', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'xai',
            description: 'xAI (Grok)',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'grok-4', description: '切换至 Grok 4', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'mistral',
            description: 'Mistral',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'mistral-large-latest', description: '切换至 Mistral Large', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'openrouter',
            description: 'OpenRouter',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'openrouter/auto', description: '切换至 OpenRouter Auto', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'moonshot',
            description: 'Moonshot (Kimi)',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'moonshot-v1-128k', description: '切换至 Moonshot V1 128K', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'qwen',
            description: 'Qwen (阿里百炼)',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'qwen3-vl-plus', description: '切换至 Qwen3 VL Plus', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'zhipu',
            description: 'Zhipu (智谱)',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'glm-4.6v', description: '切换至 GLM-4.6V', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'minimax',
            description: 'MiniMax',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'MiniMax-M3', description: '切换至 MiniMax M3', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
          {
            name: 'mimo',
            description: 'MiMo (小米)',
            icon: '\u25CF',
            category: 'model',
            children: [
              { name: 'mimo-v2.5', description: '切换至 MiMo V2.5', icon: '\u25C6', category: 'model' },
              { name: 'config', description: '调整参数...', icon: '\u2699', category: 'model' },
            ],
          },
        ],
      },
      {
        name: 'local',
        description: '管理本地模型...',
        icon: '\u{1F4BB}',
        category: 'model',
        children: [
          { name: 'start', description: '检测并启动本地服务 (Ollama / llama.cpp)', icon: '\u25B6', category: 'model', args: '<name?>' },
          { name: 'stop', description: '停止本地模型服务', icon: '\u25A0', category: 'model' },
          { name: 'status', description: '查看本地模型状态与可用模型', icon: '\u2139', category: 'model' },
          { name: 'switch', description: '切换至本地模型', icon: '\u21C4', category: 'model' },
          { name: 'register', description: '扫描并注册模型 (GGUF / Ollama)', icon: '\u2795', category: 'model' },
          { name: 'unregister', description: '注销模型', icon: '\u2796', category: 'model', args: '<name>' },
          { name: 'detect', description: '检测 Ollama / llama.cpp 安装状态', icon: '\u{1F50D}', category: 'model' },
        ],
      },
      {
        name: 'settings',
        description: '模型设置...',
        icon: '\u2699',
        category: 'model',
        children: [
          { name: 'thinking', description: '切换深度思考模式', icon: '\u{1F9E0}', category: 'model', args: '<on|off>', executeLocal: true },
          { name: 'thinking-effort', description: '设置思考深度 (1-100)', icon: '\u{1F9E0}', category: 'model', args: '<1-100>', executeLocal: true },
          { name: 'show-thinking', description: '是否显示内部思考过程', icon: '\u{1F9E0}', category: 'model', executeLocal: true },
          { name: 'context', description: '调整上下文窗口', icon: '\u229E', category: 'model', args: '<tokens>', executeLocal: true },
          { name: 'source', description: '设置角色模型来源', icon: '\u25A3', category: 'model', args: '<role> <main|local>', executeLocal: true },
          { name: 'provider', description: '切换模型提供商', icon: '\u25CF', category: 'model', args: '<name>', executeLocal: true },
          { name: 'switch', description: '切换模型名称', icon: '\u21C4', category: 'model', args: '<model-name>', executeLocal: true },
        ],
      },
      {
        name: 'info',
        description: '模型信息（当前状态）',
        icon: '\u2139',
        category: 'model',
      },
    ],
  },
  {
    name: 'context',
    description: '设置最大上下文窗口（tokens）',
    icon: '\u229E',
    category: 'config',
    args: '<tokens>',
    executeLocal: true,
  },
  {
    name: 'turns',
    description: '设置最大对话轮数',
    icon: '\u21C5',
    category: 'config',
    args: '<1-100>',
    executeLocal: true,
  },
  {
    name: 'compress',
    description: '压缩器控制（策略/阈值/深度）',
    icon: '🗜',
    category: 'config',
    children: [
      {
        name: 'compress strategy',
        description: '切换压缩策略：A=独立提示词，C=克隆对话(默认)',
        icon: '🔀',
        category: 'config',
        args: '<A|C>',
        argOptions: ['A', 'C'],
        executeLocal: true,
      },
      {
        name: 'compress threshold',
        description: '异步压缩触发阈值（0.0-1.0，默认 0.75）',
        icon: '📊',
        category: 'config',
        args: '<0.0-1.0>',
        executeLocal: true,
      },
      {
        name: 'compress emergency',
        description: '紧急同步压缩阈值（0.0-1.0，默认 0.92）',
        icon: '🚨',
        category: 'config',
        args: '<0.0-1.0>',
        executeLocal: true,
      },
      {
        name: 'compress depth',
        description: '压缩激进程度（0=极激进, 0.5=平衡, 1=保守）',
        icon: '🎚',
        category: 'config',
        args: '<0.0-1.0>',
        executeLocal: true,
      },
    ],
  },
  {
    name: 'threshold',
    description: '设置压缩触发阈值（0.0-1.0）[deprecated: 用 /compress threshold]',
    icon: '⌀',
    category: 'config',
    args: '<0.0-1.0>',
    executeLocal: true,
    deprecated: true,
  },
  {
    name: 'confirm',
    description: '切换工具确认提示（开/关）',
    icon: '\u2714',
    category: 'config',
    args: '<on|off>',
    argOptions: ['on', 'off'],
    executeLocal: true,
  },
  {
    name: 'log',
    description: '设置日志级别',
    icon: '\u{1F4DC}',
    category: 'config',
    args: '<级别>',
    argOptions: ['debug', 'info', 'warn', 'error', 'off'],
    executeLocal: true,
  },
  {
    name: 'training',
    description: '切换训练模式（开/关）',
    icon: '\u2699',
    category: 'config',
    args: '<on|off>',
    argOptions: ['on', 'off'],
    executeLocal: true,
  },
  {
    name: 'scavenge',
    description: '切换回收修复（开/关）',
    icon: '\u26CF',
    category: 'repair',
    args: '<on|off>',
    argOptions: ['on', 'off'],
    executeLocal: true,
  },
  {
    name: 'storm',
    description: '切换风暴保护（开/关）',
    icon: '\u26A1',
    category: 'repair',
    args: '<on|off>',
    argOptions: ['on', 'off'],
    executeLocal: true,
  },
  {
    name: 'storm-win',
    description: '设置风暴检测窗口大小',
    icon: '\u{1FAA8}',
    category: 'repair',
    args: '<2-20>',
    executeLocal: true,
  },
  {
    name: 'storm-th',
    description: '设置风暴检测阈值',
    icon: '\u{1F3AF}',
    category: 'repair',
    args: '<1-10>',
    executeLocal: true,
  },
  {
    name: 'schedule',
    description: '显示定时任务',
    icon: '\u23F0',
    category: 'tools',
  },
  {
    name: 'schedule-add',
    description: '添加定时任务',
    icon: '+',
    category: 'tools',
    args: '<名称> <时间>',
  },
  {
    name: 'zone4 on',
    description: '开启 Zone 4',
    icon: '\u{1F4E6}',
    category: 'config',
    executeLocal: true,
  },
  {
    name: 'zone4 off',
    description: '关闭 Zone 4（KB 同步停用）',
    icon: '\u{1F4E6}',
    category: 'config',
    executeLocal: true,
  },
  {
    name: 'kb on',
    description: '开启知识库（需 Zone 4 开启）',
    icon: '\u{1F4DA}',
    category: 'tools',
    executeLocal: true,
  },
  {
    name: 'kb off',
    description: '关闭知识库',
    icon: '\u{1F4DA}',
    category: 'tools',
    executeLocal: true,
  },
  {
    name: 'precise on',
    description: '开启精确模式（新建 session，关键词分析）',
    icon: '\u{1F3AF}',
    category: 'mode',
    executeLocal: true,
  },
  {
    name: 'precise off',
    description: '关闭精确模式（恢复普通模式）',
    icon: '\u{1F3AF}',
    category: 'mode',
    executeLocal: true,
  },
  {
    name: 'channel',
    description: '模型通道管理（多通道模型路由）',
    icon: '🔀',
    category: 'model',
    executeLocal: true,
    // 全部子命令由 childrenProvider 动态生成（参考 /session 模式）
    childrenProvider: async () => {
      try {
        const { ModelChannelRegistry } = await import('../provider/model-channel-registry.js');
        const registry = new ModelChannelRegistry(process.cwd());
        registry.load();
        const channels = registry.listChannels();

        const children: SlashCommandDef[] = [
          {
            name: 'add',
            description: '新增模型通道',
            icon: '➕',
            category: 'model',
            args: '<name> [provider] [model]',
            executeLocal: true,
          },
          {
            name: 'remove',
            description: '删除模型通道',
            icon: '➖',
            category: 'model',
            args: '<name>',
            executeLocal: true,
          },
          {
            name: 'role',
            description: '设置角色→通道映射',
            icon: '🔗',
            category: 'model',
            args: '<role> <channel>',
            executeLocal: true,
          },
        ];

        if (channels.length > 0) {
          children.push({
            name: '── 通道 ──',
            description: '展开查看操作',
            icon: ' ',
            category: 'model',
            children: [],
          } as SlashCommandDef);

          for (const ch of channels) {
            children.push({
              name: ch.name,
              description: `${ch.provider}${ch.model ? '/' + ch.model : ''}${ch.description ? ' — ' + ch.description : ''}`,
              icon: ch.name === 'main' ? '⭐' : '📡',
              category: 'model',
              children: [
                {
                  name: 'info',
                  description: '通道详情（provider/model/roles）',
                  icon: 'ℹ️',
                  category: 'model',
                  executeLocal: true,
                },
                {
                  name: 'model',
                  description: '切换通道模型（运行时，不持久化）',
                  icon: '🤖',
                  category: 'model',
                  args: '<provider> [model]',
                  executeLocal: true,
                },
                {
                  name: 'reset',
                  description: '重置为持久化配置',
                  icon: '🔄',
                  category: 'model',
                  executeLocal: true,
                },
              ],
            });
          }
        }

        children.push(
          { name: '── 全部 ──', description: '查看所有通道', icon: ' ', category: 'model', children: [] } as SlashCommandDef,
          { name: 'list', description: '列出所有通道及角色映射', icon: '📋', category: 'model', executeLocal: true },
        );

        return children;
      } catch {
        return [];
      }
    },
  },
];

// ─── CommandRegistry ─────────────────────────────────────────────────

/**
 * 命令注册中心 — 单例
 *
 * 合并内置命令 + 外部配置命令，支持热重载。
 * 模型可以通过 write/edit 工具修改 commands.json 来增删命令。
 */
export class CommandRegistry extends EventEmitter {
  private static _instance: CommandRegistry;

  private mergedCommands: SlashCommandDef[] = [];
  private userCommands: SlashCommandDef[] = [];
  private configPath: string;

  private constructor(projectDir: string) {
    super();
    this.configPath = path.join(projectDir, 'commands.json');
    this.reload();
  }

  /** 获取单例 */
  static getInstance(projectDir?: string): CommandRegistry {
    if (!CommandRegistry._instance) {
      if (!projectDir) {
        throw new Error('CommandRegistry: projectDir required for first initialization');
      }
      CommandRegistry._instance = new CommandRegistry(projectDir);
    }
    return CommandRegistry._instance;
  }

  /** 重新加载配置（热重载入口） */
  reload(): void {
    this.loadUserCommands();
    this.merge();
    this.emit('reloaded', this.mergedCommands);
    logger.info(`Commands reloaded: ${BUILTIN_COMMANDS.length} builtin + ${this.userCommands.length} user = ${this.mergedCommands.length} total`);
  }

  /** 从 commands.json 加载用户定义命令 */
  private loadUserCommands(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const config: CommandsConfig = JSON.parse(raw);
        if (Array.isArray(config.commands)) {
          this.userCommands = config.commands.filter(
            (c) => typeof c.name === 'string' && c.name.length > 0,
          );
        } else {
          this.userCommands = [];
        }
      } else {
        this.userCommands = [];
      }
    } catch (err) {
      logger.warn(`Failed to load commands.json, using builtin only: ${err instanceof Error ? err.message : String(err)}`);
      this.userCommands = [];
    }
  }

  /** 合并内置命令 + 用户命令（同名用户覆盖内置，递归合并 children） */
  private merge(): void {
    const nameMap = new Map<string, SlashCommandDef>();

    for (const cmd of BUILTIN_COMMANDS) {
      nameMap.set(cmd.name, cmd);
    }

    for (const cmd of this.userCommands) {
      const existing = nameMap.get(cmd.name);
      if (existing) {
        if (cmd.children && existing.children) {
          cmd.children = this.mergeChildren(existing.children, cmd.children);
        }
      }
      nameMap.set(cmd.name, cmd);
    }

    this.mergedCommands = [...nameMap.values()];
  }

  /** 递归合并子命令列表（按 name 去重，用户覆盖内置） */
  private mergeChildren(builtin: SlashCommandDef[], user: SlashCommandDef[]): SlashCommandDef[] {
    const map = new Map<string, SlashCommandDef>();
    for (const c of builtin) map.set(c.name, c);
    for (const c of user) {
      const existing = map.get(c.name);
      if (existing && c.children && existing.children) {
        c.children = this.mergeChildren(existing.children, c.children);
      }
      map.set(c.name, c);
    }
    return [...map.values()];
  }

  /** 获取全部命令 */
  getAll(): SlashCommandDef[] {
    return this.mergedCommands;
  }

  /** 获取用户自定义命令 */
  getUserCommands(): SlashCommandDef[] {
    return this.userCommands;
  }

  /** 获取命令配置文件路径 */
  getConfigPath(): string {
    return this.configPath;
  }

  /** 按分类分组（含子命令，继承父命令分类） */
  getByCategory(): Map<SlashCommandCategory, SlashCommandDef[]> {
    const map = new Map<SlashCommandCategory, SlashCommandDef[]>();

    const addToCategory = (cmd: SlashCommandDef, parentName?: string) => {
      const displayCmd = parentName
        ? { ...cmd, name: `${parentName}/${cmd.name}` }
        : cmd;
      const group = map.get(displayCmd.category);
      if (group) {
        group.push(displayCmd);
      } else {
        map.set(displayCmd.category, [displayCmd]);
      }
      if (cmd.children) {
        for (const child of cmd.children) {
          addToCategory(child, parentName ? `${parentName}/${cmd.name}` : cmd.name);
        }
      }
    };

    for (const cmd of this.mergedCommands) {
      addToCategory(cmd);
    }

    const ordered = new Map<SlashCommandCategory, SlashCommandDef[]>();
    for (const cat of ['system', 'session', 'model', 'config', 'repair', 'tools', 'mode'] as SlashCommandCategory[]) {
      const cmds = map.get(cat);
      if (cmds) ordered.set(cat, cmds);
    }
    return ordered;
  }

  /** 搜索过滤（递归搜索子命令） */
  filter(query: string): SlashCommandDef[] {
    const q = query.toLowerCase();
    if (!q) return this.mergedCommands;
    return this.mergedCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q) ||
        (cmd.children && this.childMatches(cmd.children, q)),
    );
  }

  /** 递归检查子命令中是否有匹配项 */
  private childMatches(children: SlashCommandDef[], q: string): boolean {
    return children.some(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        (c.children && this.childMatches(c.children, q)),
    );
  }

  /** 按名称查找（支持 "parent/child" 格式） */
  find(name: string): SlashCommandDef | undefined {
    const lower = name.toLowerCase();

    if (lower.includes('/')) {
      const parts = lower.split('/');
      let current: SlashCommandDef | undefined;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === 0) {
          current = this.mergedCommands.find((c) => c.name.toLowerCase() === part);
        } else {
          current = current?.children?.find((c) => c.name.toLowerCase() === part);
        }
        if (!current) return undefined;
      }
      return current;
    }

    const direct = this.mergedCommands.find((c) => c.name.toLowerCase() === lower);
    if (direct) return direct;

    for (const cmd of this.mergedCommands) {
      if (cmd.children) {
        const child = cmd.children.find((c) => c.name.toLowerCase() === lower);
        if (child) return child;
      }
    }
    return undefined;
  }

  /** 查找命令的父命令（如果它是子命令） */
  findParent(childName: string): SlashCommandDef | undefined {
    const lower = childName.toLowerCase();
    for (const cmd of this.mergedCommands) {
      if (cmd.children?.some((c) => c.name.toLowerCase() === lower)) {
        return cmd;
      }
    }
    return undefined;
  }

  /** 将包含 children 的命令展开为扁平列表（用于 AI prompt 等场景，全部直达可调用） */
  flattenCommands(): SlashCommandDef[] {
    const result: SlashCommandDef[] = [];
    const walk = (cmds: SlashCommandDef[], prefix: string) => {
      for (const cmd of cmds) {
        const fullName = prefix ? `${prefix}/${cmd.name}` : cmd.name;
        result.push({ ...cmd, name: fullName, children: undefined });
        if (cmd.children) {
          walk(cmd.children, fullName);
        }
      }
    };
    walk(this.mergedCommands, '');
    return result;
  }

  /** 按完整路径查找（含子命令层级），返回完整路径 */
  resolvePath(input: string): SlashCommandDef | undefined {
    return this.find(input);
  }
}