/**
 * tool-links.ts — 联动清单（第三圈：把「关系」从代码搬进数据）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是什么
 * ─────────
 * 把"**哪个工具事件上、哪个处理器做什么**"从代码搬进一份数据文件：
 *
 *     ~/.agent/tool-links.json
 *     {
 *       "version": 1,
 *       "links": [
 *         { "on": "afterToolExecute:edit", "handler": "core.references-append", "enabled": true },
 *         { "on": "afterToolExecute:write", "handler": "core.diagnostics-append", "enabled": true }
 *       ]
 *     }
 *
 * **文件里放关系，逻辑留在处理器代码里**（处理器是代码，关系是数据）。
 *
 * 它服务用户的四条诉求（研究报告 §1）：
 *   ① 有一个明确的地方统一维护工具间关系 → 本文件
 *   ② 热维护（改完即生效、无需重启）      → 配套 watcher（见 §"热更"）
 *   ③ agent 读一份文件得到全部联动关系    → 本文件 + `hyacinth arch list` 的 links 段
 *   ④ 改一处完成接线/断线                 → 改本文件（或 enabled 开关）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与「三律」的关系（别把它当成新总线）
 * ────────────────────────────────────
 * 三律③"对工具行为的反应走钩子订阅、不写进被联动工具"——本清单是它的**数据化形态**：
 * 处理器注册能力（谁来做）+ 清单声明关系（在何时做）⇒ 两者解耦 ⇒ 改关系不必改代码。
 *
 * ⚠️ **它不是新的事件总线**：事件仍由内核发射（`LOOP_HOOK_NAMES` 那 10 个钩子点），
 * 处理器仍是消费者/订阅者。本清单只回答一句话：**"这个事件上，按什么顺序调谁"**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 本轮范围（**有意缩半**，2026-09-19 与用户确认）
 * ────────────────────────────────────────────
 * **只支持 `append` / `enrich` 两类**——它们的共同语义是"给工具**加**产出，不改变
 * 工具是否执行、也不改变执行结果本身"，失败最坏只是少一份帮助（fail-safe）。
 *
 * **`veto` / `intercept` 类【留白，不实现】**，原因（写给将来的重构者）：
 *   · 它们需要一份**新契约**：`veto` 要能"自带拒绝结果"（今天实测过：通用 veto 通道只会写
 *     一句平文本 `'Tool call blocked by beforeToolExecute hook'`，承载不了 read-gate 那种
 *     "拒绝并交出当前内容"的富结果）；`intercept` 要定义"包裹/短路"的语义与顺序。
 *   · 而这份契约**只有真出现那类用例时才定得对**——现在定，等于用 1 个用例总结通用分类，
 *     一旦发布（清单是**用户机器上的数据**）就成了**要迁移的契约**，而不是"随时可重构的代码"。
 *   · ⇒ 所以：`parseToolLinks` 遇到 `veto`/`intercept` 会**明确拒绝并报错**（不是静默忽略），
 *     这样将来加这一类时只需**升级**（加一类 + 定契约），**不需要迁移**已发布的语义。
 *
 * 另一处留白（同样写给将来）：**`append` 与 `enrich` 的界限目前是"语义上的"**——
 *   · `append`：往工具结果**追加**一段文本（引用自检、写后诊断、依赖影响面都是这类）；
 *   · `enrich`：不改工具结果文本，而是**丰富别的东西**（例如"给下一轮上下文留一条注记"，
 *     今天由 `setPendingImpact` 走的正是这条路）。
 *   今天两类**都跑得通**（处理器的 run 都返回一段文本，由调用方决定贴哪儿），
 *   但这个区分将来若真要用于权限分级/顺序规则，需要各自明确契约 —— 见 §"扩展指引"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 失败语义（保旧 —— 照 extension-registry-watcher 的现成模式）
 * ──────────────────────────────────────────────────────────
 * 加载即校验；**任一条件不满足 ⇒ 整份清单不生效、保留上一份**（不是"坏一条用一条"，
 * 因为关系是有序的，半份清单比旧清单更难推理）。校验失败只 warn，不抛 —— 诊断通道
 * 不得影响主流程。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 扩展指引（将来重构者从这里开始）
 * ──────────────────────────────
 * 1. **加一类 kind**：在 `TOOL_LINK_KINDS` 加字面量 → 在 `parseToolLinks` 放开校验 →
 *    在处理器的 run 契约里补该类需要的入参/返回（`veto` 需要"能否决 + 带结果"，
 *    `intercept` 需要 next 链）→ 在 `docs/design/tool-linkage-laws.md` 记一笔。
 * 2. **加一条真实联动**：注册处理器（`ToolLinkRegistry.register`）→ 在清单里加一行 →
 *    在 `docs/design/tool-linkage-laws.md` 的成员清单里登记 → 在六处「圈三锚点」注释旁同步说明。
 * 3. **权限分级**（研究报告 §3.3 提过，本轮**未实现**）：`append/enrich` 属 agent 可改，
 *    `veto/intercept` 属架构所有且 fail-closed。**做之前先定"谁有权改什么"**——
 *    本地单用户场景下，用户已裁掉对抗性威胁模型，故这里只需**防呆**（校验 + 保旧），
 *    不需要防篡改。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 本轮支持的 kind（顺序即文档顺序；加类见文件头"扩展指引"） */
export const TOOL_LINK_KINDS = ['append', 'enrich'] as const;
export type ToolLinkKind = (typeof TOOL_LINK_KINDS)[number];

/** 暂不支持的 kind —— 单独列出，是为了让报错信息**说得清为什么**（而不是"未知 kind"） */
export const RESERVED_TOOL_LINK_KINDS = ['veto', 'intercept'] as const;

export interface ToolLink {
  /** 事件名，形态 `"<hookName>:<toolName>"`（toolName 可省，表示该钩子上所有工具） */
  on: string;
  /** 处理器 id（须已注册，见 ToolLinkRegistry） */
  handler: string;
  /** 缺省视为 true（清单里只写想要的行即可） */
  enabled?: boolean;
}

export interface ToolLinksManifest {
  version: number;
  links: ToolLink[];
}

export const TOOL_LINKS_VERSION = 1;

/** 清单路径 —— **全局单层**（P-Config 收敛：项目级配置已取消，不做双层） */
export function toolLinksPath(): string {
  return path.join(os.homedir(), '.agent', 'tool-links.json');
}

/**
 * 出厂默认清单：**与今天的行为逐条对应**（没有清单文件时，一切照旧）。
 *
 * ⚠️ 为什么这里**没有** `core.dependency-impact-enrich`（依赖影响面）：
 *   它是**批量级**的——一次算出**所有**被改文件的合并影响、再一次性写入 pending
 *   （见 loop-tools 里那段 `editedFiles.map(getImpact)`）；而本清单的处理器是**按调用**
 *   触发的（每次工具调用一次）⇒ 纳入它会让"合并列表"退化成"只剩最后一次调用"。
 *   要纳入，得先有一个**批量级事件**（如 `afterToolBatch`）——那是新钩子，属另一件事，
 *   故本轮明确留白（与 veto/intercept 同款处理：**不假装支持**）。
 *
 */
export function defaultToolLinks(): ToolLinksManifest {
  return {
    version: TOOL_LINKS_VERSION,
    links: [
      // 顺序 = 执行顺序（今天的可见顺序：工具结果 → 诊断 → 引用自检）
      { on: 'afterToolExecute:write', handler: 'core.diagnostics-append', enabled: true },
      { on: 'afterToolExecute:edit', handler: 'core.diagnostics-append', enabled: true },
      { on: 'afterToolExecute:write', handler: 'core.references-append', enabled: true },
      { on: 'afterToolExecute:edit', handler: 'core.references-append', enabled: true },
      // 证据账本只对 bash 有意义（"跑过验证类命令"）；副作用型，run 返回空串
      { on: 'afterToolExecute:bash', handler: 'core.evidence-ledger-append', enabled: true },
    ],
  };
}

/**
 * **结构校验**（只做"不依赖外部知识"的那一半）。
 *
 * 为什么分两半：语义校验（事件名必须在目录里、处理器必须已注册）需要 `LOOP_HOOK_NAMES`
 * 与注册表——它们分别住在 orchestrator 与运行时，本模块（supervisor 层）不该 import 它们
 * （verify:layers 的层次约束）。故那半放在 `validateToolLinks`，由调用方把知识注入。
 *
 * 宽容策略沿用 extension-registry：**非法条目剔除并记入 errors**，合法条目保留
 * （注意：是否采用"带错误的结果"由调用方决定 —— watcher 的语义是"有错就整份保旧"）。
 */
export function parseToolLinks(raw: unknown): { manifest: ToolLinksManifest; errors: string[] } {
  const errors: string[] = [];
  const empty: ToolLinksManifest = { version: TOOL_LINKS_VERSION, links: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: empty, errors: ['tool-links root must be an object'] };
  }
  const root = raw as { version?: unknown; links?: unknown };
  const version = typeof root.version === 'number' ? root.version : TOOL_LINKS_VERSION;
  if (version !== TOOL_LINKS_VERSION) {
    // 不做版本迁移（清单刚落地，没有旧版本要迁）；将来加版本时在这里分派
    errors.push(`unsupported version ${version} (expected ${TOOL_LINKS_VERSION})`);
  }
  if (!Array.isArray(root.links)) {
    errors.push('links must be an array');
    return { manifest: { version, links: [] }, errors };
  }

  const links: ToolLink[] = [];
  const seen = new Set<string>();
  root.links.forEach((item, i) => {
    const l = item as { on?: unknown; handler?: unknown; kind?: unknown; enabled?: unknown };
    if (typeof l?.on !== 'string' || l.on.length === 0) {
      errors.push(`links[${i}]: missing "on"`);
      return;
    }
    if (typeof l.handler !== 'string' || l.handler.length === 0) {
      errors.push(`links[${i}]: missing "handler"`);
      return;
    }
    if (l.enabled !== undefined && typeof l.enabled !== 'boolean') {
      errors.push(`links[${i}]: "enabled" must be boolean`);
      return;
    }
    // 「on」的形态：`<hook>` 或 `<hook>:<tool>`——这里只查"有没有钩子名"，名字是否在目录由语义校验做
    if (!/^[A-Za-z][A-Za-z0-9]*(:[A-Za-z0-9_*]+)?$/.test(l.on)) {
      errors.push(`links[${i}]: "on" must look like "afterToolExecute" or "afterToolExecute:edit"`);
      return;
    }
    // 保留类 kind：**明确拒绝并说明原因**（不是"未知 kind"）——见文件头"本轮范围"
    if (typeof l.kind === 'string' && (RESERVED_TOOL_LINK_KINDS as readonly string[]).includes(l.kind)) {
      errors.push(
        `links[${i}]: kind "${l.kind}" is reserved and NOT implemented in this round — `
        + 'veto/intercept need a new contract (see header of src/supervisor/tool-links.ts)',
      );
      return;
    }
    // 去重：同一 (on, handler) 只允许一条 —— 重复只会让人怀疑"到底跑几次"
    const key = `${l.on}→${l.handler}`;
    if (seen.has(key)) {
      errors.push(`links[${i}]: duplicate binding ${key}`);
      return;
    }
    seen.add(key);
    links.push({ on: l.on, handler: l.handler, ...(l.enabled === undefined ? {} : { enabled: l.enabled }) });
  });

  return { manifest: { version, links }, errors };
}

/**
 * **语义校验**（需要外部知识：事件目录 + 已注册处理器）。
 * 知识由调用方注入 —— 本模块不 import orchestrator/运行时（层次约束，见上）。
 */
export function validateToolLinks(
  manifest: ToolLinksManifest,
  knowledge: { eventNames: readonly string[]; handlerIds: readonly string[] },
): string[] {
  const errors: string[] = [];
  const events = new Set(knowledge.eventNames);
  const handlers = new Set(knowledge.handlerIds);
  manifest.links.forEach((l, i) => {
    const [hook] = l.on.split(':');
    if (!events.has(hook)) {
      errors.push(`links[${i}]: unknown event "${hook}" (not in the hook catalogue)`);
    }
    if (!handlers.has(l.handler)) {
      errors.push(`links[${i}]: unknown handler "${l.handler}" (not registered)`);
    }
  });
  return errors;
}

/** 读 + 结构校验（**不抛**：文件缺失/坏掉都返回默认清单 + 错误列表） */
export function loadToolLinks(): { manifest: ToolLinksManifest; errors: string[]; path: string; existed: boolean } {
  const p = toolLinksPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    // 没有清单文件 ⇒ 出厂默认（= 今天的行为）——**行为不回退**的关键
    return { manifest: defaultToolLinks(), errors: [], path: p, existed: false };
  }
  try {
    const parsed = parseToolLinks(JSON.parse(raw));
    return { ...parsed, path: p, existed: true };
  } catch (err) {
    return { manifest: defaultToolLinks(), errors: [`invalid JSON: ${(err as Error).message}`], path: p, existed: true };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 「当前清单」持有者（进程级配置，与 config-center / extension-registry 同法）
// ────────────────────────────────────────────────────────────────────────────
/**
 * 为什么是模块级持有者（而不是每 loop 一份）：
 *   · 清单是**进程级配置**（一份文件、一个真相），与"多会话/子代理各一份"的语义不符；
 *   · 热更（watcher）只需更新**一个**地方 ⇒ 所有 loop 立刻看到新清单 ✓。
 * 处理器注册表则可以每装配一份（见 ToolLinkRegistry 注释）——但**核心处理器是无状态的**
 * 纯函数，所以实现上用了进程级注册表（buildCoreToolLinkRegistry），省掉一条装配链。
 * ⚠️ 将来若出现**有状态**的处理器（如批量级累积），必须改成每 loop/每装配一份。
 */
let currentManifest: ToolLinksManifest = defaultToolLinks();

/** 当前生效的清单（消费者每次读它 ⇒ 热更即时生效） */
export function getCurrentToolLinks(): ToolLinksManifest {
  return currentManifest;
}

/** 替换当前清单（watcher 专用；**调用方负责先校验** —— 见 loadToolLinks + validateToolLinks） */
export function setCurrentToolLinks(manifest: ToolLinksManifest): void {
  currentManifest = manifest;
}

// ────────────────────────────────────────────────────────────────────────────
// 处理器注册面
// ────────────────────────────────────────────────────────────────────────────

/**
 * 处理器的运行入参 —— 有意保持**最小**：将来加 kind 时，这里是第一个要动的地方。
 *
 * `payload` 是**调用方（内核后置序列）**塞进来的上下文（工具入参、能力探针、副作用通道…）；
 * 本模块刻意只声明为 unknown：supervisor 层不认识 ToolCall / ToolExecContext，保持层次干净
 * （verify:layers 规则 4/5）。处理器自己声明它期待的形状（见 orchestrator/tool-link-handlers.ts）。
 */
export interface ToolLinkRunInput {
  /** 事件名（与原清单里的 "on" 一致，便于处理器自己判断） */
  event: string;
  /** 工具名（从事件名里拆出的那一段；可能为 undefined） */
  toolName?: string;
  /** 调用方上下文（形状由处理器约定） */
  payload?: unknown;
}

export interface ToolLinkHandler {
  /** 稳定 id —— 清单里的 `handler` 字段引用它 */
  id: string;
  /** 本轮只允许 append/enrich（见文件头"本轮范围"） */
  kind: ToolLinkKind;
  /** 归属：core 由内核注册；plugin 由插件注册（将来做权限分级时的判据） */
  owner: 'core' | 'plugin';
  /** 关心的事件（`"afterToolExecute:edit"` 形态；可多条） */
  on: string | string[];
  /**
   * 执行 —— 返回**要追加的文本**（空串 = 本处理器这次没有产出）。
   * ⚠️ 契约：**不得抛错**（抛了会被调用方吞掉退化为"无产出"，但那是浪费）；失败就返回空串。
   */
  run(input: ToolLinkRunInput): Promise<string>;
}

/**
 * 处理器注册表。
 *
 * 为什么是**实例**而不是模块级单例：单例难测试、也难在同一进程里跑两个装配（子代理/多会话）。
 * 由装配层创建一份并注入（与 `StageServiceMap`、插件宿主服务面同法）。
 */
export class ToolLinkRegistry {
  private readonly handlers = new Map<string, ToolLinkHandler>();

  register(h: ToolLinkHandler): void {
    if (this.handlers.has(h.id)) {
      throw new Error(`[tool-links] handler "${h.id}" already registered`);
    }
    if (!(TOOL_LINK_KINDS as readonly string[]).includes(h.kind)) {
      // 将来加 kind 时，这里会拦住"注册了但契约没实现"的处理器 —— 有意如此
      throw new Error(
        `[tool-links] handler "${h.id}" kind "${h.kind}" is not implemented in this round `
        + '(see header of src/supervisor/tool-links.ts)',
      );
    }
    this.handlers.set(h.id, h);
  }

  get(id: string): ToolLinkHandler | undefined {
    return this.handlers.get(id);
  }

  ids(): string[] {
    return [...this.handlers.keys()];
  }

  all(): ToolLinkHandler[] {
    return [...this.handlers.values()];
  }

  /** 该事件上**按清单顺序**应调用的处理器（enabled 过滤由调用方按清单做，这里只解析注册面） */
  forEvent(event: string): ToolLinkHandler[] {
    return this.all().filter((h) => {
      const ons = Array.isArray(h.on) ? h.on : [h.on];
      return ons.some((o) => o === event || o === event.split(':')[0]);
    });
  }
}

/**
 * 把清单解析成"这次事件上按顺序要跑哪些处理器"。
 *
 * 这是**清单 → 执行**的唯一转换点（将来加 kind 只改这里 + run 契约）。
 * 返回的项已过滤：disabled 的不返回；handler 未注册的**跳过并记 warn**（
 * 语义校验理应已拦住，但清单可以热更到"处理器还没注册"的中间态 ⇒ 这里再兜一层）。
 */
export function resolveToolLinks(
  manifest: ToolLinksManifest,
  registry: ToolLinkRegistry,
  event: string,
): { handler: ToolLinkHandler; link: ToolLink }[] {
  const out: { handler: ToolLinkHandler; link: ToolLink }[] = [];
  for (const link of manifest.links) {
    if (link.enabled === false) continue;
    if (link.on !== event && link.on !== event.split(':')[0]) continue;
    const handler = registry.get(link.handler);
    if (!handler) continue;
    out.push({ handler, link });
  }
  return out;
}
