import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';
const logger = createLogger('session-allowlist');

export interface SessionAllowlistData {
  allowedTools: string[];
  allowedCommands: string[];
  /**
   * 经用户确认放行的「可写根」（会话级）。
   *
   * 用途（2026-10-13 权限统一）：工作区围栏对**越界写入**不再硬拒、改为可确认。
   * 用户选 yes/always/aor 后，把该写路径的**父目录**记到这里 ⇒ 围栏据此放行。
   * 与 allowedTools 的区别：后者是"这个工具不用再问"，前者是"这个目录可以写"——
   * 精度更高（一次授权不会顺带放开该工具的所有越界写入）。
   */
  allowedWriteRoots: string[];
  /**
   * AOR（Absence of Restriction：本会话全放行）—— **会话级持久化**（2026-10-13）。
   *
   * 为什么持久化：AOR 原先是 loop 的实例字段，**进程一重启就丢**，用户在同一会话里
   * 每次重启都得重新按一遍权限条。
   *
   * ⚠️ 防越权约束（改这里务必一并检查）：
   *   · 只写**本 sessionDir** ⇒ **不跨会话**（换会话即恢复默认，这也是关闭 AOR 最省事的途径）；
   *   · 它**不解除工作区围栏**：`.git` 仍恒拒，越界写入仍走围栏判定（AOR 只让"越界要确认"
   *     这一步自动通过 —— 见 loop-tools 里 AOR 记批准根的逻辑）；
   *   · 恢复时 loop 会**主动提示一次**：重启后不再弹权限条，不提示用户就会忘掉自己还在全放行。
   */
  unrestricted: boolean;
}

const EMPTY_DATA: SessionAllowlistData = {
  allowedTools: [],
  allowedCommands: [],
  allowedWriteRoots: [],
  unrestricted: false,
};

/** 数组字段兜底：老 allowlist.json 缺 allowedWriteRoots ⇒ 视为空（向后兼容） */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 布尔字段兜底：老 allowlist.json 缺 unrestricted ⇒ 视为 false（**宁可少放行**） */
function asBool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : false;
}

/** 统一的字段解析（异步 load 与同步 loadSync 共用，避免两处漂移） */
function parseData(parsed: Record<string, unknown>): SessionAllowlistData {
  return {
    allowedTools: asStringArray(parsed.allowedTools),
    allowedCommands: asStringArray(parsed.allowedCommands),
    allowedWriteRoots: asStringArray(parsed.allowedWriteRoots),
    unrestricted: asBool(parsed.unrestricted),
  };
}

export async function load(sessionDir: string): Promise<SessionAllowlistData> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, 'allowlist.json'), 'utf-8');
    return parseData(JSON.parse(raw));
  } catch {
    // ⚠️ 必须**深拷贝**：EMPTY_DATA 是模块级单例，其数组字段（allowedWriteRoots 等）
    // 若被浅拷贝共享，`addWriteRoot` 里的 push 会**改写全局** ⇒ 此后所有"空返回"
    // 都带上该根 ⇒ **跨会话静默放行**（2026-10-13 审计 B3，已实测：
    // 在 A 会话记根后，B 会话 isWriteRootAllowed(B, 该根) === true）。
    return structuredClone(EMPTY_DATA);
  }
}

/**
 * 同步版 load —— **只给 loop 构造函数用**（见 isUnrestrictedSync）。
 * 与 load 共用 parseData，两处行为不会漂移。
 */
function loadSync(sessionDir: string): SessionAllowlistData {
  try {
    const raw = readFileSync(path.join(sessionDir, 'allowlist.json'), 'utf-8');
    return parseData(JSON.parse(raw));
  } catch {
    return structuredClone(EMPTY_DATA);   // 同上：深拷贝，防污染模块级单例
  }
}

export async function save(sessionDir: string, data: SessionAllowlistData): Promise<void> {
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'allowlist.json'),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  } catch (err) {
    logger.warn('Failed to save allowlist', { sessionDir, error: String(err) });
  }
}

export async function addTool(sessionDir: string, toolName: string): Promise<void> {
  const data = await load(sessionDir);
  if (!data.allowedTools.includes(toolName)) {
    data.allowedTools.push(toolName);
  }
  await save(sessionDir, data);
}

export async function addCommand(sessionDir: string, command: string): Promise<void> {
  const data = await load(sessionDir);
  if (!data.allowedCommands.includes(command)) {
    data.allowedCommands.push(command);
  }
  await save(sessionDir, data);
}

/** 记入一个「已批准的可写根」（越界写入经用户确认后调用） */
export async function addWriteRoot(sessionDir: string, root: string): Promise<void> {
  const data = await load(sessionDir);
  if (!data.allowedWriteRoots.includes(root)) {
    data.allowedWriteRoots.push(root);
  }
  await save(sessionDir, data);
}

/** 记入/取消 AOR（会话级全放行）。关闭时**显式写 false**，便于人工核对文件确认已关 */
export async function setUnrestricted(sessionDir: string, on: boolean): Promise<void> {
  const data = await load(sessionDir);
  if (data.unrestricted !== on) {
    data.unrestricted = on;
    await save(sessionDir, data);
  }
}

/**
 * 同步读 AOR 状态 —— **只给 loop 构造函数用**。
 *
 * 为什么必须同步：构造函数本身是同步的。若改用异步回填，首轮工具调用可能**早于**恢复完成
 * ⇒ 明明持久化了却仍弹一次权限条（这种"偶发不确定性"比慢几十微秒坏得多）。文件只有几百字节。
 */
export function isUnrestrictedSync(sessionDir: string): boolean {
  return loadSync(sessionDir).unrestricted;
}

export async function isToolAllowed(sessionDir: string, toolName: string): Promise<boolean> {
  const data = await load(sessionDir);
  return data.allowedTools.includes(toolName);
}

export async function isCommandAllowed(sessionDir: string, command: string): Promise<boolean> {
  const data = await load(sessionDir);
  return data.allowedCommands.includes(command);
}

export async function isWriteRootAllowed(sessionDir: string, root: string): Promise<boolean> {
  const data = await load(sessionDir);
  return data.allowedWriteRoots.includes(root);
}

/** 读取全部已批准可写根（供装配层在会话启动时回填内存集合） */
export async function getWriteRoots(sessionDir: string): Promise<string[]> {
  return (await load(sessionDir)).allowedWriteRoots;
}
