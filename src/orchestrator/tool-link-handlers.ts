/**
 * tool-link-handlers.ts — **核心**联动处理器（清单里 `core.*` 那些 id 的实现）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 定位（先读这段，再看代码）
 * ────────────────────────
 * 三律③的正面形态：这里只做"**对工具行为的反应**"，工具本身不认识它们。
 * 因此本模块**不 import 任何工具实现**——它只认「结构事实账本」与「能力探针」（三律②），
 * 于是"改上游坏下游"的面被压到最小：它消费的都是**结构事实**，不是别人生产的语义。
 *
 * 本轮三个处理器（都是 **append** 类，fail-safe：**失败返回空串，绝不影响工具结果**）：
 *   core.diagnostics-append      写后诊断（write/edit）——"真的写了"的判据 = diff 账本有条目
 *   core.references-append       引用自检（write/edit）——能力优先，否则核心字符串扫描兜底
 *   core.evidence-ledger-append  验证证据账本（bash）——副作用型，run 返回空串
 *
 * ⚠️ **依赖影响面（core.dependency-impact-enrich）故意不在本文件**：它是**批量级**的
 *    （一次算所有被改文件的合并影响），按调用触发会退化 ⇒ 仍留在 loop-tools 里硬编码，
 *    要纳入需先有批量级事件（见 utils/tool-links.ts 的 defaultToolLinks 注释）。
 *
 * ⚠️ **veto / intercept 类不在本轮范围**（清单模块会明确拒绝这类 kind）——
 *    它们需要"自带拒绝结果 / 包裹语义"的新契约，见 utils/tool-links.ts 文件头。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 将来加处理器（三步，照做即可）
 * ────────────────────────────────────────────────────────────────────────────
 *   ① 在下面实现一个 ToolLinkHandler（id 用 `core.<名字>-append|enrich`）；
 *      注意 run 的契约：**不得抛错**（失败返回空串）。
 *   ② 在 buildCoreToolLinkRegistry 里 register —— **register 顺序 = 执行顺序**
 *      （且要与 defaultToolLinks 里的顺序一致，否则"清单顺序"与"注册顺序"会打架）。
 *   ③ 在 utils/tool-links.ts 的 defaultToolLinks 里加一行（= 出厂默认就启用）。
 *      若要**默认关闭**，就别加进默认清单，让用户自己往 ~/.agent/tool-links.json 里写。
 *   ④ 在 docs/design/tool-linkage-laws.md 的成员清单里登记，并在六处「圈三锚点」注释旁同步说明。
 */
import { ToolLinkRegistry, type ToolLinkHandler } from '../utils/tool-links.js';

/**
 * 核心处理器的 payload 形状（**调用方 loop-tools 负责塞进来**）。
 * 清单模块把 payload 声明为 unknown（supervisor 层不认识 ToolCall/ToolExecContext，保持层次干净），
 * **形状在这里约定** —— 将来加处理器若需要更多上下文，改这里 + 改 loop-tools 的塞入点。
 */
export interface CoreHandlerPayload {
  /** 工具调用的入参（结构事实：file_path 等） */
  input?: Record<string, unknown>;
  /** 能力探针（引用自检优先用它；缺省/为空则退核心兜底） */
  capability?: unknown;
  /** 副作用通道（证据账本用；由调用方注入，避免本模块依赖 loop 内部状态） */
  effects?: { addEvidence?: () => void };
}

const asPayload = (raw: unknown): CoreHandlerPayload => (raw as CoreHandlerPayload | undefined) ?? {};

/** `core.diagnostics-append`：写后诊断（判据："真的写了" = diff 账本里有条目） */
export const diagnosticsAppendHandler: ToolLinkHandler = {
  id: 'core.diagnostics-append',
  kind: 'append',
  owner: 'core',
  on: ['afterToolExecute:write', 'afterToolExecute:edit'],
  run: async (linkInput) => {
    const filePath = asPayload(linkInput.payload).input?.file_path;
    if (typeof filePath !== 'string') return '';
    try {
      // 用 peek（读而不删）：账本的事实可被多个消费者读，消费在各执行路径的末尾统一做。
      // 被读门控拒绝的调用不推 diff ⇒ 这里自然拿不到 ⇒ 不诊断（与搬出工具前行为一致）。
      const { peekDiff } = await import('../tools/diff-channel.js');
      if (!peekDiff(filePath)) return '';
      const { maybeRunDiagnostics } = await import('../tools/diagnostics.js');
      return (await maybeRunDiagnostics(process.cwd())) ?? '';
    } catch {
      return ''; // 诊断失败不影响工具结果（与从前一致）
    }
  },
};

/** `core.references-append`：引用自检（能力优先 → 核心字符串扫描兜底） */
export const referencesAppendHandler: ToolLinkHandler = {
  id: 'core.references-append',
  kind: 'append',
  owner: 'core',
  on: ['afterToolExecute:write', 'afterToolExecute:edit'],
  run: async (linkInput) => {
    const payload = asPayload(linkInput.payload);
    const filePath = payload.input?.file_path;
    if (typeof filePath !== 'string') return '';
    const toolName = linkInput.toolName;
    if (toolName !== 'write' && toolName !== 'edit') return '';
    try {
      const { peekDiff } = await import('../tools/diff-channel.js');
      const entry = peekDiff(filePath);
      if (entry?.before === undefined || entry.after === undefined) return '';
      const { analyzeReferences } = await import('../tools/reference-analysis.js');
      return await analyzeReferences(payload.capability as never, {
        toolName,
        filePath,
        before: entry.before,
        after: entry.after,
        args: payload.input,
      });
    } catch {
      return ''; // 自检失败不影响工具返回值（与从前一致）
    }
  },
};

/** `core.evidence-ledger-append`：验证证据账本（副作用型，run 返回空串） */
export const evidenceLedgerHandler: ToolLinkHandler = {
  id: 'core.evidence-ledger-append',
  kind: 'append',
  owner: 'core',
  on: 'afterToolExecute:bash',
  run: async (linkInput) => {
    const payload = asPayload(linkInput.payload);
    if (payload.input) {
      const { isVerificationEvidence } = await import('../tools/evidence.js');
      if (isVerificationEvidence(linkInput.toolName ?? '', payload.input)) {
        payload.effects?.addEvidence?.();
      }
    }
    return '';
  },
};

/**
 * 组装核心注册表 —— **进程级一份**（这些处理器无状态）。
 * 若有**有状态**处理器：改成每装配一份，并把 utils/tool-links.ts 里 currentManifest
 * 持有者一并改成每 loop 一份（那边的 ⚠️ 有说明）。
 */
let coreRegistry: ToolLinkRegistry | null = null;

export function buildCoreToolLinkRegistry(): ToolLinkRegistry {
  if (coreRegistry) return coreRegistry;
  const reg = new ToolLinkRegistry();
  // 注册顺序 = 执行顺序（与 defaultToolLinks 里的顺序保持一致）
  reg.register(diagnosticsAppendHandler);
  reg.register(referencesAppendHandler);
  reg.register(evidenceLedgerHandler);
  coreRegistry = reg;
  return reg;
}
