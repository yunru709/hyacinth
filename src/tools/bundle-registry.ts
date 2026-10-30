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

/**
 * 通用工具包 —— **始终加载，不可关闭**。
 *
 * 判据（2026-10-10 收口）：**三类缺一不可** ——
 *   ① 逃生舱：缺了会被锁死（包管理三件套 + bash + switch_mode）
 *   ② 高频刚需：缺了每轮都得用 shell 绕（read/write/edit/insert/glob/grep/probe）
 *   ③ 自控与通讯：缺了会失控 / 失语（interrupt/restart/trigger_compression +
 *      say/ask_user + process_*）
 * 三类之外（会话管理 / 工作流 / 回滚 / 通用工具 / 陪伴 / 自观测 / 定时 / 媒体…）
 * 一律按需包 —— 随时能 activate_bundle 取回，不构成「被困住」。
 *
 * 往这里加工具前先问：**没有它，agent 会不会被困住？** 会 → 进 common；不会 → 按需包。
 * bundle-consistency.test.ts 的「守则③」把这条最小集固化成断言，守则④把
 * 「按需工具不得回灌」也固化，防日后顺手加回。
 */
const BUILTIN_COMMON: ToolBundle = {
  name: 'common',
  description: '通用工具包 — 始终加载，不可关闭（agent 的自我管理最小集）',
  builtin: true,
  tools: [
    // ── ① 逃生舱：不被锁死 ──
    // 包管理三件套（漏了它，任何瘦身都会让 agent 锁死）+ bash（万能逃生舱）。
    'list_bundles', 'activate_bundle', 'deactivate_bundle',
    'bash',
    // ── ② 高频刚需：基础读写执行（不走 shell，比 bash 可靠）──
    // probe 与 grep 同族（在文件里找东西）：grep 面向文本行，probe 面向二进制/
    // 超大/编码混杂文件的上下文窗口。
    'read', 'write', 'edit', 'insert', 'glob', 'grep', 'probe',
    // ── ③ 自控与通讯 ──
    // 进程三件套是 bash(async) 的伴侣：起了后台进程就必须能看见 / 停掉。
    'interrupt', 'restart', 'trigger_compression',
    'process_list', 'process_kill', 'process_output',
    // say = 说话（短、会朗读、不结束回合）；deliver = 交付（长文、不朗读、结束回合）。
    // 两者都是「能不能开口」的基础设施 ⇒ 与 interrupt/switch_mode 同级必须常驻，
    // 否则默认 coding 包下我会变成哑巴（说不了、也交不了）。
    'say', 'deliver', 'ask_user',
    // ── 模式进出 ──
    // switch_mode 是**模式无关**的通用入口：任何模式下都必须能用它进出 ⇒ 漏了它
    // = 默认 coding 包下「进得去、出不来」✗（由 bundle-consistency 守卫测试抓出过）。
    'switch_mode',
    // ── 感知：能不能「看见」用户给的东西，不该取决于激活了哪个包 ──
    'view_image', 'view_media',
  ],
};

const BUILTIN_CODING: ToolBundle = {
  name: 'coding',
  description: '编程工具包 — 版本控制、交叉引用、代码技能（通用工具已自动包含）',
  builtin: true,
  // 注意：这里曾写作 multi-edit（连字符），而工具实际注册名是 multi_edit（下划线）
  // —— 死条目，导致 multi_edit 不在任何包内、默认 coding 模式下直接消失。
  // 由 bundle-consistency 守卫测试抓出（见该测试头部说明）。
  tools: ['git', 'multi_edit', 'use_skill', 'verify_change', 'log_timeline',
          'xref_build', 'xref_query', 'xref_graph', 'xref_list', 'plan_execute'],
};

const BUILTIN_AGENT: ToolBundle = {
  name: 'agent',
  description: '子 Agent 编排 — 创建和管理子 Agent 执行复杂任务',
  builtin: true,
  // 曾漏掉 list_sub_agent_tasks / get_sub_agent_result：同族 7 个在包内、这 2 个不在，
  // 默认模式下「能派活却看不到任务状态」。守卫测试抓出。
  tools: ['spawn_sub_agent', 'create_sub_agent', 'update_sub_agent', 'destroy_sub_agent',
          'delegate_to_agent', 'list_sub_agents', 'toggle_sub_agent', 'use_skill',
          'list_sub_agent_tasks', 'get_sub_agent_result'],
};

const BUILTIN_ADMIN: ToolBundle = {
  name: 'admin',
  description: '系统管理 — Provider / 配置 / 权限 / 工具包创作 / 自观测',
  builtin: true,
  tools: [
    'list_providers', 'provider_info', 'switch_provider', 'switch_to_auto_route',
    'get_config', 'update_config', 'config_schema', 'reset_config',
    'list_tools', 'toggle_tool',
    'list_skills', 'toggle_skill', 'list_sub_agents', 'toggle_sub_agent',
    'allow_tool', 'disallow_tool', 'list_allowlist',
    'list_model_channels', 'add_model_channel', 'remove_model_channel',
    'set_channel_role', 'set_channel_model', 'reset_channel_model',
    'model_channel_info',  // 同族 7 个在包内、它漏了（守卫测试抓出）
    // 配置一致性自检：与「配置管理」同族 —— 它回答的正是「我这份配置对不对」
    'check_config',
    // 自观测（2026-10-10 从 common 移入）：缺了不会被困住，运营 / 排查时才用。
    'system_info', 'channel_info', 'mcp_status',
    // 工具包**创作**（2026-10-10 从 common 移入）：注意逃生舱三件套
    // list_bundles / activate_bundle / deactivate_bundle 仍在 common；
    // 这里只是造包 / 改包的写操作，罕用 ⇒ 按需。
    'create_bundle', 'add_to_bundle', 'remove_from_bundle', 'delete_bundle',
  ],
};

/** 会话管理（2026-10-10 从 common 移出）—— 切不了会话不影响 agent 自我解困，故非逃生舱 */
const BUILTIN_SESSION: ToolBundle = {
  name: 'session',
  description: '会话管理 — 查看 / 新建 / 切换 / 删除会话与分支（按需激活）',
  builtin: true,
  tools: [
    'current_session', 'list_sessions', 'new_session', 'switch_session',
    'delete_session', 'session_fork', 'session_stats',
  ],
};

/** 工作流与回溯（2026-10-10 从 common 移出）—— 引导式流程 + goal 模式入口/验收 + 回合回滚 */
const BUILTIN_WORKFLOW: ToolBundle = {
  name: 'workflow',
  description: '工作流与回溯 — 引导式流程（todo/spec）、goal 模式入口/验收、回合回滚（按需激活）',
  builtin: true,
  tools: [
    'flow_start', 'flow_add', 'flow_complete',
    'enter_goal', 'finish_goal', 'exit_goal',
    'rollback_status', 'rollback',
  ],
};

/** 通用工具（2026-10-10 从 common 移出）—— 文件 / 网络 / 渠道 / 后台监控杂项 */
const BUILTIN_UTILITY: ToolBundle = {
  name: 'utility',
  description: '通用工具 — 文件比较 / JSON 编辑 / HTTP / 压缩 / 磁盘 / 后台监控 / 渠道外发（按需激活）',
  builtin: true,
  tools: [
    'diff_files', 'json_edit', 'http_request', 'archive', 'disk_usage',
    // 后台监控 4 个（watch_*）—— 定义在 src/watch/tool.ts，此前游离在所有包外，
    // 只有全量模式可见。归入 utility（通用监控/等待）。2026-10-30 整理。
    'watch_start', 'watch_wait', 'watch_stop', 'watch_list',
    'send_channel_message',
  ],
};

/**
 * 陪伴模式工具（2026-10-10 从 common 移出）。
 *
 * ⚠️ 与「执行侧门禁」强耦合：陪伴模式靠 Router 白名单放行这些工具，
 * 而执行侧门禁（loop.ts 的 isToolAllowedByBundle）**必须先认白名单、再看 bundle**
 * —— 否则会「组装侧看得见、执行侧拦下来」。同批已按此修。
 */
const BUILTIN_COMPANION: ToolBundle = {
  name: 'companion',
  description: '陪伴模式 — 模式开关 / 角色管理 / 表达（按需激活）',
  builtin: true,
  tools: ['companion_mode', 'reset_companion_session', 'companion_say'],
};

/** 知识库 — 六个 kb_* 工具此前**不在任何包内**（默认模式下整个知识库不可用，守卫测试抓出） */
const BUILTIN_KNOWLEDGE: ToolBundle = {
  name: 'knowledge',
  description: '知识库 — 文档索引与结构化记忆的增删查改（按需激活）',
  builtin: true,
  tools: ['kb_add', 'kb_list', 'kb_update', 'kb_delete', 'kb_toggle', 'kb_structured'],
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

/**
 * 定时任务 —— 按需激活（2026-10-08 从 common 拆出）。
 *
 * 为什么不在 common：按判据「没有它 agent 会不会被困住」—— **不会**。定时任务是
 * 功能，不能定时并不影响 agent 管理自己（而「能不能切包 / 切会话 / 中断自己」才影响）。
 * 需要时 activate_bundle 一步取回，不会失去能力。
 */
const BUILTIN_SCHEDULE: ToolBundle = {
  name: 'schedule',
  description: '定时任务 — 让 agent 在未来某刻自动开工（按需激活）',
  builtin: true,
  tools: ['add_task', 'list_tasks', 'remove_task', 'toggle_task'],
};

/**
 * 自动化链路 —— 按需激活（2026-10-30）。此前 automation_* 4 个工具游离在
 * 所有 bundle 之外（只有全量模式可见），补上专属包。
 *
 * 与 schedule 的分工（不是重复）：
 *   schedule  = 模型/用户"一句话定时提醒"——走 HeartbeatScheduler，自带 cron / 持久化 /
 *               补执行 / 并发·超时 / 执行记录；工具 add_task 等，简洁。
 *   automation = "触发(定时/状态/事件) → 多步动作链"——零模型按图执行，
 *               支持 invoke 跑工具 / wake 唤醒会话 / gate 分支 / loop 循环 / maxRuns。
 * 一个面向"简单定时"，一个面向"复杂编排"。
 */
const BUILTIN_AUTOMATION: ToolBundle = {
  name: 'automation',
  description: '自动化链路 — 触发(定时/状态/事件) → 多步动作链（零模型执行，按需激活）',
  builtin: true,
  tools: ['automation_validate', 'automation_create', 'automation_list', 'automation_remove'],
};

/**
 * 媒体生成 —— 按需激活（2026-10-08 从 common 拆出）。
 *
 * 注意区分：**看见**（view_image / view_media）留在 common —— 感知用户给的
 * 东西不该取决于激活了哪个包；**生成**（图片/视频/音频）是创作场景，拆出去。
 */
const BUILTIN_MEDIA: ToolBundle = {
  name: 'media',
  description: '媒体生成 — 图片 / 视频 / 音频（按需激活）',
  builtin: true,
  tools: ['generate_media'],
};

/** 全部内置包定义（顺序无关；load() 用它做缺项补齐与工具列表回填） */
const BUILTIN_BUNDLES: ToolBundle[] = [
  BUILTIN_ALL, BUILTIN_COMMON, BUILTIN_CODING,
  BUILTIN_AGENT, BUILTIN_ADMIN, BUILTIN_SESSION, BUILTIN_WORKFLOW, BUILTIN_UTILITY,
  BUILTIN_COMPANION, BUILTIN_OFFICE, BUILTIN_DATABASE, BUILTIN_KNOWLEDGE,
  BUILTIN_SCHEDULE, BUILTIN_AUTOMATION, BUILTIN_MEDIA,
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
  bundles: {
    all: BUILTIN_ALL, common: BUILTIN_COMMON, coding: BUILTIN_CODING,
    agent: BUILTIN_AGENT, admin: BUILTIN_ADMIN,
    session: BUILTIN_SESSION, workflow: BUILTIN_WORKFLOW, utility: BUILTIN_UTILITY,
    companion: BUILTIN_COMPANION,
    office: BUILTIN_OFFICE, database: BUILTIN_DATABASE, knowledge: BUILTIN_KNOWLEDGE,
    schedule: BUILTIN_SCHEDULE, automation: BUILTIN_AUTOMATION, media: BUILTIN_MEDIA,
  },
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

  /** 列出所有 bundle（**插入顺序** —— 会被 MCP 断连重连打乱，见 listStable） */
  list(): ToolBundle[] {
    return Object.values(this.config.bundles);
  }

  /**
   * 列出所有 bundle —— **按 name 稳定排序**。
   *
   * ★ 为什么必须单立一个方法（2026-10-14 修缓存抖动）：
   *   `list()` 返回 `Object.values(config.bundles)`，即**插入顺序**。而 MCP 工具包由
   *   `syncTools` 在**运行期**动态建删（server 连接建包、断开删包）—— `delete` 之后再
   *   `create` 会把该包挪到对象**末尾**，于是插入顺序随「谁先断线重连」而漂移。
   *
   *   这个顺序会被**渲染进 Zone 2 的 tool_bundles 段**，而该段位于 Zone 2 末尾、其后
   *   紧跟整个 Zone 3（对话历史）⇒ 顺序一变，**整块前缀缓存作废**（自动前缀缓存的判据
   *   是"从头开始连续逐字节相同"）。表现即命中率无规律暴跌。
   *
   *   姊妹段（skills / agents / mcp，见 section-resolver.buildSourcePartsFromCtx）早已
   *   显式按 name 排序抗这种漂移，**唯独本段此前漏了** —— 故补齐。
   *
   * 凡"要进上下文 / 要跨轮稳定"的调用方一律用本方法；`list()` 保留原语义，供
   * 「按创建先后顺序」的极少数场景（如 list_bundles 工具输出）使用。
   */
  listStable(): ToolBundle[] {
    return [...this.list()].sort((a, b) => a.name.localeCompare(b.name));
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

  /**
   * 精确同步一个 bundle 的工具列表 —— 供**外部自动维护**使用（当前用途：MCP server 的工具集）。
   *
   * 与 addTools/removeTools 的区别：那两个是**增量**，这个是**对齐**（以 tools 为准多退少补）——
   * MCP server 重连后工具可能增删，增量做法会残留幽灵条目。
   *
   * ⚠️⚠️ **tools 为空 ⇒ 删除该包，绝不留下空包**。原因：`tools: []` 在本模块的语义是
   *   「无过滤 = 全量」（见 BUILTIN_ALL），留个空包会让「激活它」变成**放开一切** ——
   *   与「按需收窄」的意图正好相反，而且是静默的。
   * ⚠️ 删除若导致激活集变空，必须回填 common：空激活集同样等于全量模式
   *   （见 getActiveToolNames 的 `if (actives.length === 0) return []`）。
   *   这不是用户的选择（用户只是拔掉了一个 MCP），所以不能顺势滑进全量。
   */
  syncTools(name: string, description: string, tools: string[]): void {
    if (tools.length === 0) {
      if (!this.config.bundles[name]) return;
      const wasActive = this.config.activeBundles.includes(name);
      this.delete(name);
      if (wasActive && this.config.activeBundles.length === 0) {
        this.config.activeBundles = ['common'];
        this.save();
        logger.info('active bundles fell empty after removing a synced bundle → fell back to common');
      }
      return;
    }
    const existing = this.config.bundles[name];
    if (existing) {
      existing.description = description;
      existing.tools = [...tools];
      // 同步包不是内置包：清掉这些标记，避免 load() 把它当内置包做工具回填/元数据覆盖。
      delete existing.removedTools;
      delete existing.builtin;
      this.save();
      logger.info(`Bundle synced: ${name} (${tools.length} tools)`);
      return;
    }
    this.create(name, description, tools);
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
        // 内置包的工具**归属以代码为准**：盘上多出来的条目只有两种身份 ——
        //   ① 用户自己加的自定义工具（不属于任何内置包）→ 保留
        //   ② 代码已把该工具挪去别的内置包（2026-10-08：定时任务 common → schedule、
        //      媒体生成 → media）→ 剔除。否则并集会把盘上的旧条目加回来，拆包白拆 ✗
        const builtinElsewhere = new Set(
          BUILTIN_BUNDLES.filter((x) => x.name !== b.name).flatMap((x) => x.tools),
        );
        existing.tools = [...new Set([...b.tools, ...existing.tools])].filter(
          (t: string) => b.tools.includes(t) || !builtinElsewhere.has(t),
        );
        // 元数据以代码为准：description 原先不参与合并 ⇒ 盘上文件里的历史文案会一直
        // 显示在 list_bundles / UI 里（实测 coding 包长期显示旧描述"依赖分析"，
        // 而代码早已改成"交叉引用"）。工具列表会并回，元数据同样得跟上。
        if (b.description) existing.description = b.description;
        existing.builtin = true;
        // 再剔除用户显式移出的（否则内置包永远删不掉工具）
        const removed = new Set<string>(existing.removedTools ?? []);
        if (removed.size) {
          existing.tools = existing.tools.filter((t: string) => !removed.has(t));
          // 自愈：removedTools 只对「内置工具」有意义 —— 不在内置工具表里的名字永远
          // 不会被回填，记录它纯属噪声，还会静默剔除将来可能出现的同名工具。
          // 实测盘上残留 6 个幽灵名（task_start / multi-edit / code-graph …）。
          const live = [...removed].filter((t) => b.tools.includes(t));
          if (live.length) existing.removedTools = live;
          else delete existing.removedTools;
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
