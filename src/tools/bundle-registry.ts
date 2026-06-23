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
}

export interface ToolBundlesConfig {
  /** 当前激活的工具包名列表。空数组 = 全量模式（不限制）。["all"] 等价于空数组。 */
  activeBundles: string[];
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
    'read', 'write', 'edit', 'insert', 'bash', 'glob', 'grep',
    'list_bundles', 'activate_bundle', 'deactivate_bundle',
    'create_bundle', 'add_to_bundle', 'remove_from_bundle', 'delete_bundle',
    'workflow', 'convert_skill_to_workflow', 'interrupt', 'restart',
    'add_task', 'list_tasks', 'remove_task', 'toggle_task',
    'mcp_status', 'session_stats',
    'diff_files', 'json_edit', 'http_request', 'archive',
  ],
};

const BUILTIN_CODING: ToolBundle = {
  name: 'coding',
  description: '编程工具包 — 版本控制、依赖分析、代码技能（通用工具已自动包含）',
  builtin: true,
  tools: ['git', 'code-graph', 'multi-edit', 'function-context', 'use_skill'],
};

const BUILTIN_AGENT: ToolBundle = {
  name: 'agent',
  description: '子 Agent 编排 — 创建和管理子 Agent 执行复杂任务',
  builtin: true,
  tools: ['spawn_sub_agent', 'create_sub_agent', 'update_sub_agent', 'delegate_to_agent', 'use_skill'],
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
    'trigger_training', 'cancel_training', 'toggle_training', 'training_status', 'set_training_schedule',
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

const DEFAULT_CONFIG: ToolBundlesConfig = {
  activeBundles: [],
  bundles: { all: BUILTIN_ALL, common: BUILTIN_COMMON, coding: BUILTIN_CODING, agent: BUILTIN_AGENT, admin: BUILTIN_ADMIN, office: BUILTIN_OFFICE, database: BUILTIN_DATABASE },
};

// ── Registry ───────────────────────────────────────────────────────

export class ToolBundleRegistry {
  private configPath: string;
  private config: ToolBundlesConfig;

  constructor(cwd: string) {
    this.configPath = path.join(os.homedir(), '.agent', 'tool-bundles.json');
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
    this.config.activeBundles = names.includes('all') ? [] : names;
    this.save();
  }

  /** 取消所有 bundle 限制，回到全量 */
  deactivate(): void {
    this.config.activeBundles = [];
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
    if (added.length > 0) {
      this.save();
      logger.info(`Tools added to bundle ${bundleName}: ${added.join(', ')}`);
    }
  }

  /** 从 bundle 移除工具 */
  removeTools(bundleName: string, toolNames: string[]): void {
    const bundle = this.config.bundles[bundleName];
    if (!bundle) throw new Error(`Bundle "${bundleName}" not found.`);
    bundle.tools = bundle.tools.filter(t => !toolNames.includes(t));
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
      const builtins = [BUILTIN_ALL, BUILTIN_COMMON, BUILTIN_CODING, BUILTIN_AGENT, BUILTIN_ADMIN, BUILTIN_OFFICE, BUILTIN_DATABASE];
      for (const b of builtins) {
        if (!parsed.bundles) parsed.bundles = { [b.name]: b };
        else if (!parsed.bundles[b.name]) {
          parsed.bundles[b.name] = b;
        } else {
          // Existing builtin: merge tool list (ensure builtin tools are always present,
          // preserving any user-added tools)
          const existing = parsed.bundles[b.name];
          existing.tools = [...new Set([...b.tools, ...existing.tools])];
        }
      }
      return parsed as ToolBundlesConfig;
    } catch {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      return { ...DEFAULT_CONFIG, bundles: { all: { ...BUILTIN_ALL } } };
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
