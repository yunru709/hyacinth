/**
 * reference-analysis-state.ts — 引用自检的**运行态快照**（供进程外诊断读取）
 *
 * 为什么在 utils 而不在 tools（规则 5 亲自教的）：本模块是**只读 + 纯格式化**的诊断数据面，
 * UI 侧（channels / gateway 的 arch 段）本来就要用它 —— 放 tools/ 会让 UI 适配层直连业务核心，
 * 被 verify:layers 规则 5 拦下；utils/ 属 UI 侧可直连的中立层，两边都能合法导入。
 *
 * 为什么需要：`hyacinth arch list` 是**进程外诊断**（源码注释明写"不启动 agent"），
 * 拿不到活的能力实例；UI 协议域的 arch 域也只有一个数据源注入口。
 * 故：能力每次分析后把一份**紧凑快照**写到 ~/.agent/reference-analysis-state.json，
 * 两个入口（CLI / UI 协议域）都读它 ⇒ 都能显示能力状态与计数（验收线要求）。
 *
 * 诚实边界（写进输出里，不靠使用者猜）：
 *   · 快照可能来自**上一个进程**（带 updatedAt/pid）—— 它反映"最近一次真实运行态"，
 *     不是"此刻"；故展示时必须把时间与 pid 一并给出。
 *   · 读写都**不抛**：文件不存在 / 坏掉 / 无写权限 ⇒ 读得 null、写则静默失败。
 *     诊断通道绝不能因为自身故障影响主流程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ReferenceAnalysisSnapshot {
  /** 提供方（目前恒为 'xref'；留字段以便将来多个提供方） */
  provider: string;
  /** 能力是否处于注册状态（挂载即 true；卸载后由摘除方写 false） */
  registered: boolean;
  /** 累计调用次数 */
  calls: number;
  /** 累计"给不出结论→交给兜底"次数 */
  fallbacks: number;
  /** 最近一次给不出结论的原因（最有诊断价值的一格） */
  lastReason: string;
  /** 最近一次成功分析的时间（ISO；空 = 从未成功） */
  lastAt: string;
  /** 最近一次涉及的符号 */
  lastSymbols: string[];
  /** 最近一次产出（截断留档） */
  lastOutput: string;
  /** 快照写入时间（ISO） */
  updatedAt: string;
  /** 写入进程 pid（用于判断"是不是当前进程"） */
  pid: number;
}

export function snapshotPath(): string {
  return path.join(os.homedir(), '.agent', 'reference-analysis-state.json');
}

/** 写快照（best-effort，绝不抛） */
export function writeSnapshot(s: Omit<ReferenceAnalysisSnapshot, 'updatedAt' | 'pid'>): void {
  try {
    const p = snapshotPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const full: ReferenceAnalysisSnapshot = { ...s, updatedAt: new Date().toISOString(), pid: process.pid };
    fs.writeFileSync(p, JSON.stringify(full, null, 2) + '\n', 'utf8');
  } catch {
    // 诊断通道的自故障不得影响主流程
  }
}

/** 读快照 —— 不存在 / 坏掉 / 字段缺失一律返回 null（绝不抛） */
export function readSnapshot(): ReferenceAnalysisSnapshot | null {
  try {
    const raw = fs.readFileSync(snapshotPath(), 'utf8');
    const o = JSON.parse(raw) as Partial<ReferenceAnalysisSnapshot>;
    if (typeof o.calls !== 'number') return null; // 形状不对 → 当作没有
    return {
      provider: typeof o.provider === 'string' ? o.provider : 'xref',
      registered: o.registered === true,
      calls: o.calls,
      fallbacks: typeof o.fallbacks === 'number' ? o.fallbacks : 0,
      lastReason: typeof o.lastReason === 'string' ? o.lastReason : '',
      lastAt: typeof o.lastAt === 'string' ? o.lastAt : '',
      lastSymbols: Array.isArray(o.lastSymbols) ? o.lastSymbols.filter((x): x is string => typeof x === 'string') : [],
      lastOutput: typeof o.lastOutput === 'string' ? o.lastOutput : '',
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
      pid: typeof o.pid === 'number' ? o.pid : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 把 links 段格式化成文本（**纯函数**，两个入口共用 + 可单测）。
 * `pluginEnabled` 由调用方给出（CLI 从名单裁决、UI 从装配态）——本函数不猜。
 */
export function formatLinksSection(
  snapshot: ReferenceAnalysisSnapshot | null,
  pluginEnabled: boolean | null,
): string {
  const lines: string[] = ['── 联动（links）──'];
  lines.push('  消费者：引用自检（核心后置序列，始终启用 —— 不依赖任何插件）');

  const providerState =
    pluginEnabled === false
      ? 'xref 插件已禁用'
      : pluginEnabled === true
        ? 'xref 插件已启用'
        : 'xref 插件状态未知';
  lines.push(`  能力提供方：referenceAnalysis ← ${providerState}（挂载时注册、卸载即摘除）`);

  if (!snapshot || !snapshot.registered) {
    // 验收线：未注册时也要**显示出来**，不是留白
    lines.push('  能力未注册（走核心兜底）');
  } else {
    lines.push(
      `  运行态：calls=${snapshot.calls} fallbacks=${snapshot.fallbacks}`
      + `  最近原因="${snapshot.lastReason || '（无）'}"`,
    );
    if (snapshot.lastSymbols.length > 0) lines.push(`  最近符号：${snapshot.lastSymbols.join(', ')}`);
    if (snapshot.lastAt) lines.push(`  最近成功：${snapshot.lastAt}`);
  }
  if (snapshot?.updatedAt) {
    // 诚实：快照可能来自上一个进程，故给出时间与 pid
    lines.push(`  （快照 ${snapshot.updatedAt}，pid=${snapshot.pid}${snapshot.pid === process.pid ? '（即当前进程）' : '（非同进程，反映最近一次运行态）'}）`);
  }
  return lines.join('\n');
}
