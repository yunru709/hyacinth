/**
 * anchor.ts — 项目锚（anchor）解析：把"裸 cwd"升级为真正的项目根
 *
 * 为什么需要（manager.ts 里那起事故的另一半）：索引按 `projectKey = toProjectKey(rootDir)`
 * 分库，而插件传进来的是 `services.cwd` —— **cwd 对 agent 不等于项目根**：
 * 同一个项目，从仓库根启动与从 `src/` 子目录启动会得到**两个库**，互相看不见彼此的索引
 *（"按目录跨 session 共享"因此打了折扣）。
 *
 * 依据链（**顺序即优先级**）：
 *   ① `HYACINTH_XREF_ROOT` 环境变量 —— agent 的显式声明，最高优先（与
 *      HYACINTH_SESSIONS_ROOT / HYACINTH_MODEL_CHANNELS_PATH 同一套约定）
 *   ② 逐层向上 `stat .git` —— 有 .git 的那层就是项目根（比标记更权威）
 *   ③ 逐层向上找项目标记：package.json / go.mod / Cargo.toml / pyproject.toml / pom.xml
 *   ④ 都没有 → 用起点目录本身，并给出警告（不是错误：一个没有标记的脚本目录是合法目标）
 *
 * 两条硬约束（都来自任务单，且都是**踩过坑之后的教训**）：
 *   · **只 stat 固定文件名，绝不枚举目录内容** —— 枚举会把"探测"变成"扫描"，
 *     在用户主目录那类大树上代价失控；何况索引本身才是扫描，探测必须极廉价。
 *   · **禁区不作锚**：主目录、主目录的祖先、盘符根一律不作为锚（命中即停在起点 + 警告）。
 *     否则 `.git`/标记恰好落在禁区的极端情况会把 GB 级垃圾库重新引出来。
 *
 * 先例：edit/write 的内联引用自检（symbol-references）已有同款"逐层向上探测"逻辑，
 * 本模块是它在 xref 侧的对应物。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 项目标记（只看**固定文件名**，不做目录枚举） */
export const PROJECT_MARKERS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml'] as const;

/** 向上探测的层数上限（防御：异常路径下不至于无限上溯） */
const MAX_UPWARD = 12;

export type AnchorReason =
  | 'env'
  | 'git'
  | `marker:${string}`
  | 'cwd';

export interface AnchorResult {
  /** 用作项目标识的目录（正斜杠绝对路径，与库内 path 规范一致） */
  root: string;
  /** 判定依据 —— 写进构建输出/诊断，让人看得出"为什么是这里" */
  reason: AnchorReason;
  /** 降级时的说明（禁区命中 / 走到头都没标记） */
  warning?: string;
}

function norm(p: string): string {
  const r = path.resolve(p).replace(/[/\\]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 禁区：主目录本身、主目录的祖先（含盘符根）—— 与 assertIndexableRoot 同一口径 */
export function isForbiddenAnchor(dir: string): boolean {
  const d = norm(dir);
  const home = norm(os.homedir());
  if (d === home) return true;
  if (home.startsWith(d + path.sep)) return true;
  return false;
}

/**
 * 解析项目锚。绝不抛错（降级为"用起点 + 警告"）—— 锚只是**分库键**，
 * 拿不准时用起点是安全的保守选择（至多多一个库，不会索引错东西）。
 */
export function resolveAnchor(startDir: string): AnchorResult {
  const start = path.resolve(startDir);
  const asResult = (root: string, reason: AnchorReason, warning?: string): AnchorResult => ({
    root: root.replace(/\\/g, '/'),
    reason,
    ...(warning ? { warning } : {}),
  });

  // ① 显式声明
  const declared = process.env.HYACINTH_XREF_ROOT;
  if (declared && declared.trim()) {
    const d = path.resolve(declared.trim());
    if (isForbiddenAnchor(d)) {
      return asResult(start, 'cwd', `HYACINTH_XREF_ROOT 指向禁区（${declared}），已忽略，退回起点目录`);
    }
    return asResult(d, 'env');
  }

  // 逐层候选（起点 → 上溯 MAX_UPWARD 层），**只 stat 固定名字，不枚举**
  const levels: string[] = [];
  let cur = start;
  for (let i = 0; i < MAX_UPWARD; i++) {
    if (isForbiddenAnchor(cur)) break; // 禁区不作锚，也不越过它继续上溯
    levels.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break; // 到顶
    cur = parent;
  }

  // ② .git 优先（比标记更权威：有 .git 的那层就是项目根）
  for (const dir of levels) {
    if (fs.existsSync(path.join(dir, '.git'))) return asResult(dir, 'git');
  }

  // ③ 项目标记
  for (const dir of levels) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return asResult(dir, `marker:${marker}`);
    }
  }

  // ④ 退回起点 + 警告
  return asResult(
    start,
    'cwd',
    levels.length < MAX_UPWARD
      ? `未找到 .git 或项目标记（向上探测途中遇到禁区即停），以起点目录为项目标识：${start}`
      : `向上探测 ${MAX_UPWARD} 层未找到 .git 或项目标记，以起点目录为项目标识：${start}`,
  );
}
