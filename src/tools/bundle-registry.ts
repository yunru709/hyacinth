import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('tool-bundle');

// ── Types ──────────────────────────────────────────────────────────

export interface ToolBundle {
  name: string;
  description: string;
  builtin?: boolean;
  tools: string[];  // 空数组 = 全量（无过滤）
  /**
   * 从内置包中显式移除的工具。
   *
   * 存在原因：load() 每次都会把内置包的工具列表并回来（保证版本升级后新增的
   * 内置工具能自动进包）。若只从 tools 里删，重启后就被并回来了 —— 内置包
   * 实际上删不掉。这里把「用户主动移出」记录下来，load() 合并后再剔除。
   *
   * 仅对 builtin 包有意义；自定义包直接改 tools 即可。
   */
  removedTools?: string[];
}

export interface ToolBundlesConfig {
  /** 当前激活的工具包名列表。空数组 = 全量模式（不限制）。["all"] 等价于空数组。 */
  activeBundles: string[];
  /**
   * 用户是否已显式选择过工具包。
   *
   * true = 用户主动 activate/deactivate 过，此后默认值迁移不得再改动它。
   * 缺省 false —— 只享受过「旧版默认全量」的用户会被一次性迁到新默认包。
   */
  activeBundlesExplicit?: boolean;
  /** 配置结构版本（用于一次性迁移，见 load()） */
  configVersion?: number;
  bundles: Record<string, ToolBundle>;
}

// ── Default ────────────────────────────────────────────────────────

const BUILTIN_ALL: ToolBundle = {
  name: 'all',
  description: '全量工具包 — 包含所有已注册工具（默认激活，可切换）',
  builtin: true,
  tools: [],  // 空 = 无过滤
};

const BUILTIN_COMMON: ToolBundle = {
  name: 'common',
  description: '通用工具包 — 始终加载，不可关闭',
  builtin: true,
  tools: [
    // probe 与 grep 同族（在文件里找东西）：grep 面向文本行，probe 面向二进制/
    // 超大/编码混杂文件的"上下文窗口"，必须进 common 与 grep 同列，否则默认
    // coding 包下模型看不到它。
    'read', 'write', 'edit', 'insert', 'bash', 'glob', 'grep', 'probe',
    'list_bundles', 'activate_bundle', 'deactivate_bundle',
    'create_bundle', 'add_to_bundle', 'remove_from_bundle', 'delete_bundle',
    'system_info', 'channel_info',
    'interrupt', 'restart',
    'add_task', 'list_tasks', 'remove_task', 'toggle_task',
    'mcp_status', 'session_stats',
    'diff_files', 'json_edit', 'http_request', 'archive',
    'companion_mode', 'reset_companion_session', 'trigger_compression',
    'disk_usage', 'view_image', 'view_media',
    'process_list', 'process_kill', 'process_output',
    'rollback_status', 'rollback',
    'flow_start', 'flow_add', 'flow_complete',
    'session_fork',
    'ask_user',
    // say 与 ask_user 同属核心交互工具：交付结论并结束回合，
    // 必须进 common（始终加载）否则默认 coding 包下模型看不到它。
    'say',
  ],
};

const BUILTIN_CODING: ToolBundle = {
  name: 'coding',
  description: '编程工具包 — 版本控制、交叉引用、代码技能（通用工具已自动包含）',
  builtin: true,
  tools: ['git', 'multi-edit', 'use_skill', 'verify_change',
          'xref_build', 'xref_query', 'xref_graph', 'plan_execute'],
};

const BUILTIN_AGENT: ToolBundle = {
  name: 'agent',
  description: '子 Agent 编排 — 创建和管理子 Agent 执行复杂任务',
  builtin: true,
  tools: ['spawn_sub_agent', 'create_sub_agent', 'update_sub_agent', 'destroy_sub_agent', 'delegate_to_agent', 'use_skill'],
};

const BUILTIN_ADMIN: ToolBundle = {
  name: 'admin',
  description: '系统管理 — Provider 切换、配置管理、权限控制',
  builtin: true,
  tools: [
    'list_providers', 'provider_info', 'switch_provider', 'switch_to_auto_route',
    'get_config', 'update_config', 'config_schema', 'reset_config',
    'session_stats', 'list_tools', 'toggle_tool',
    'list_skills', 'toggle_skill', 'list_sub_agents', 'toggle_sub_agent',
    'allow_tool', 'disallow_tool', 'list_allowlist',
    'list_model_channels', 'add_model_channel', 'remove_model_channel',
    'set_channel_role', 'set_channel_model', 'reset_channel_model',
  ],
};

const BUILTIN_OFFICE: ToolBundle = {
  name: 'office',
  description: '办公文档 — 读取 Word/Excel 文件（按需激活）',
  builtin: true,
  tools: ['docx_read', 'xlsx_read'],
};

const BUILTIN_DATABASE: ToolBundle = {
  name: 'database',
  description: '数据库 — SQLite 参数化查询（按需激活）',
  builtin: true,
  tools: ['db_query'],
};

/** 全部内置包定义（顺序无关；load() 用它做缺项补齐与工具列表回填） */
const BUILTIN_BUNDLES: ToolBundle[] = [
  BUILTIN_ALL, BUILTIN_COMMON, BUILTIN_CODING,
  BUILTIN_AGENT, BUILTIN_ADMIN, BUILTIN_OFFICE, BUILTIN_DATABASE,
];

/** 内置包名称集合（供测试与 UI 判定） */
export const BUILTIN_BUNDLE_NAMES: readonly string[] = BUILTIN_BUNDLES.map((b) => b.name);

const DEFAULT_CONFIG: ToolBundlesConfig = {
  // 默认只激活 coding 包（common 包由 getActiveToolNames() 始终包含，无需列出）。
  // 理由：全工具默认暴露会让每轮请求固定背上全部 schema 的 token 开销，
  // 且工具数量过多会拉低模型的选择准确率。其余包按需 activate。
  activeBundles: ['coding'],
  // 配置结构版本。用于把「已存在的旧配置」迁移到新的默认工具包，
  // 同时不会覆盖用户显式选择过的全量模式。
  configVersion: 2,
  bundles: { all: BUILTIN_ALL, common: BUILTIN_COMMON, coding: BUILTIN_CODING, agent: BUILTIN_AGENT, admin: BUILTIN_ADMIN, office: BUILTIN_OFFICE, database: BUILTIN_DATABASE },
};

// ── Helpers ────────────────────────────────────────────────────────

/** 浅拷贝一个 bundle（含数组），避免就地修改污染常量定义 */
function cloneBundle(b: ToolBundle): ToolBundle {
  return {
    ...b,
    tools: [...b.tools],
    ...(b.removedTools ? { removedTools: [...b.removedTools] } : {}),
  };
}

// ── Registry ───────────────────────────────────────────────────────

export class ToolBundleRegistry {
  private configPath: string;
  private config: ToolBundlesConfig;

  constructor(cwd: string, configPath?: string) {
    this.configPath = configPath ?? path.join(os.homedir(), '.agent', 'tool-bundles.json');
    this.config = this.load();
  }

  // ── Query ────────────────────────────────────────────────────────

  /** 当前是否全量模式（无工具限制） */
  isAllMode(): boolean {
    const names = this.config.activeBundles;
    return names.length === 0 || names.includes('all');
  }

  /** 返回当前激活的所有 bundle */
  getActive(): ToolBundle[] {
    if (this.isAllMode()) return [];
    return this.config.activeBundles
      .map(n => this.config.bundles[n])
      .filter(Boolean);
  }

  /** 返回当前激活的工具名并集（已去重）。空数组 = 全量。始终包含 common 包。 */
  getActiveToolNames(): string[] {
    const actives = this.getActive();
    if (actives.length === 0) return [];  // 全量模式
    const set = new Set<string>();
    // common 包始终加载
    const common = this.config.bundles['common'];
    if (common) {
      for (const t of common.tools) set.add(t);
    }
    for (const b of actives) {
      for (const t of b.tools) set.add(t);
    }
    return [...set];
  }

  /** 获取指定 bundle */
  get(name: string): ToolBundle | undefined {
    return this.config.bundles[name];
  }

  /** 列出所有 bundle */
  list(): ToolBundle[] {
    return Object.values(this.config.bundles);
  }

  // ── Mutate ───────────────────────────────────────────────────────

  /** 设置激活的 bundle 列表。空数组或 ["all"] = 全量模式。 */
  activate(names: string[]): void {
    for (const n of names) {
      if (!this.config.bundles[n]) {
        throw new Error(`Bundle "${n}" not found. Use list_bundles to see available bundles.`);
      }
    }
    // "all" 参与则等价于全量
    // 标记为用户显式选择：后续默认包迁移不得再覆盖
    this.config.activeBundles = names.includes('all') ? [] : names;
    this.config.activeBundlesExplicit = true;
    this.config.configVersion = 2;
    this.save();
  }

  /** 取消所有 bundle 限制，回到全量 */
  deactivate(): void {
    this.config.activeBundles = [];
    this.config.activeBundlesExplicit = true;
    this.config.configVersion = 2;
    this.save();
  }


  /** 创建新 bundle */
  create(name: string, description: string, tools: string[]): ToolBundle {
    if (this.config.bundles[name]) {
      throw new Error(`Bundle "${name}" already exists.`);
    }
    const bundle: ToolBundle = { name, description, tools };
    this.config.bundles[name] = bundle;
    this.save();
    logger.info(`Bundle created: ${name} (${tools.length} tools)`);
    return bundle;
  }

  /** 删除 bundle（builtin 不可删，common 不可删） */
  delete(name: string): void {
    const bundle = this.config.bundles[name];
    if (!bundle) throw new Error(`Bundle "${name}" not found.`);
    if (bundle.builtin) throw new Error(`Cannot delete builtin bundle "${name}".`);
    if (name === 'common') throw new Error(`Cannot delete the common bundle — it is always required.`);
    delete this.config.bundles[name];
    this.config.activeBundles = this.config.activeBundles.filter(n => n !== name);
    this.save();
    logger.info(`Bundle deleted: ${name}`);
  }

  /** 向 bundle 追加工具 */
  addTools(bundleName: string, toolNames: string[]): void {
    const bundle = this.config.bundles[bundleName];
    if (!bundle) throw new Error(`Bundle "${bundleName}" not found.`);
    const added: string[] = [];
    for (const t of toolNames) {
      if (!bundle.tools.includes(t)) {
        bundle.tools.push(t);
        added.push(t);
      }
    }
    // 重新加入即撤销「移出」记录，否则 load() 时又会被剔除
    if (bundle.removedTools && bundle.removedTools.length) {
      const reAdded = new Set(toolNames);
      bundle.removedTools = bundle.removedTools.filter((t) => !reAdded.has(t));
    }
    if (added.length > 0) {
      this.save();
      logger.info(`Tools added to bundle ${bundleName}: ${added.join(', ')}`);
    }
  }

  /** 从 bundle 移除工具（内置包也会持久生效，记录到 removedTools） */
  removeTools(bundleName: string, toolNames: string[]): void {
    const bundle = this.config.bundles[bundleName];
    if (!bundle) throw new Error(`Bundle "${bundleName}" not found.`);
    const removing = new Set(toolNames);
    bundle.tools = bundle.tools.filter(t => !removing.has(t));
    // 内置包：记录移出，对抗 load() 的 builtin 回填
    if (bundle.builtin) {
      const removed = new Set(bundle.removedTools ?? []);
      for (const t of toolNames) removed.add(t);
      bundle.removedTools = [...removed];
    }
    this.save();
    logger.info(`Tools removed from bundle ${bundleName}: ${toolNames.join(', ')}`);
  }

  // ── Persist ──────────────────────────────────────────────────────

  reload(): void {
    this.config = this.load();
    logger.info('Bundle config reloaded');
  }

  private load(): ToolBundlesConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Ensure builtin bundles always exist with latest tool lists
      for (const b of BUILTIN_BUNDLES) {
        // 注意：必须 clone。直接把模块级常量塞进 config，后续 addTools/removeTools
        // 会就地改到 BUILTIN_* 上，污染整个进程内其他实例读到的默认值。
        if (!parsed.bundles) {
          parsed.bundles = { [b.name]: cloneBundle(b) };
          continue;
        }
        if (!parsed.bundles[b.name]) {
          parsed.bundles[b.name] = cloneBundle(b);
          continue;
        }
        // Existing builtin: merge tool list (ensure builtin tools are always present,
        // preserving any user-added tools)
        const existing = parsed.bundles[b.name];
        existing.tools = [...new Set([...b.tools, ...existing.tools])];
        // 再剔除用户显式移出的（否则内置包永远删不掉工具）
        const removed = new Set(existing.removedTools ?? []);
        if (removed.size) {
          existing.tools = existing.tools.filter((t: string) => !removed.has(t));
        }
      }

      // ── 一次性迁移：默认工具包 全量 → coding ──
      // 旧版本默认 activeBundles: []（= 全量）。仅改代码默认对已存在配置无效，
      // 因为 load() 优先用盘上配置。这里对「从未显式选择过」的用户做一次迁移。
      const version = (parsed.configVersion ?? 1) as number;
      if (version < 2 && !parsed.activeBundlesExplicit) {
        parsed.activeBundles = [...DEFAULT_CONFIG.activeBundles];
        logger.info(
          `Bundle 默认工具包迁移 v${version} → v2：全量 → ${DEFAULT_CONFIG.activeBundles.join(', ')}`,
        );
      }
      parsed.configVersion = 2;
      // 迁移落盘，避免每次启动重复执行
      if (version < 2 && !parsed.activeBundlesExplicit) {
        try {
          fs.writeFileSync(this.configPath, JSON.stringify(parsed, null, 2), 'utf-8');
        } catch {
          /* 写盘失败不影响本次会话使用迁移结果 */
        }
      }

      return parsed as ToolBundlesConfig;
    } catch {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      // 与写盘保持一致：返回完整默认配置的深拷贝（含全部内置包），
      // 否则首次启动只有 all 一个包，且会就地改到模块级常量上
      return {
        ...DEFAULT_CONFIG,
        bundles: Object.fromEntries(
          Object.entries(DEFAULT_CONFIG.bundles).map(([k, v]) => [k, cloneBundle(v)]),
        ),
      };
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`Failed to save bundle config: ${(err as Error).message}`);
    }
  }
}
