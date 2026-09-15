// ============================================================
// 孤儿子进程清扫器（MCP 专用 + 通用 watchdog 兜底）
// ============================================================
// 背景：后端被外部强杀（Windows TerminateProcess，如 taskkill /F、
// 任务管理器、agent 会话清理）时，'exit' 钩子无法拦截，其子进程树
// （MCP Server / 本地模型 / bash 命令）会整体变成孤儿常驻。
//
// 两道清扫：
//   1. MCP 特征串模式（原逻辑）—— MCPSystem.start() 连接前执行：
//      枚举 node/python/cmd 进程，命令行匹配当前 MCP 配置特征串且
//      父进程已死的判定为孤儿，按树 taskkill。特征串从配置 args
//      推导（如 chrome-devtools-mcp），排除 npx/node/serve 等通用词；
//      宁可漏杀不误杀。
//   2. watchdog 标记模式（新增，通用兜底）—— lifecycle/watchdog.ts
//      为每个受管子进程挂的守护进程命令行带 `hyacinth-wd:<pid>` 特征；
//      若守护进程自身也孤儿化（父死但尚未完成杀树），下次启动时按
//      该特征找到它，先杀目标树再杀守护进程，把强杀路径的最后漏洞
//      补上（守护进程正常会在父死后 1.5s 内自行完成，此为兜底）。
//
// 仅 Windows 执行（Unix 上孤儿由 init 收养，且 detached 进程组已可用）。
// ============================================================

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logging/logger.js';
import { killProcessTreeSync, WATCHDOG_MARK } from '../lifecycle/watchdog.js';
import type { MCPConfig } from '../types.js';

const execAsync = promisify(execCb);
const logger = createLogger('mcp:orphan-sweeper');

/** 从 MCP 配置推导进程命令行特征串（小写；用于子串匹配） */
export function deriveMarkers(configs: MCPConfig[]): string[] {
  // 通用词：单独出现不足以标识某个 MCP Server
  const generic = new Set([
    'npx', 'node', 'npm', 'python', 'python3', 'python.exe',
    'cmd', 'serve', 'start', 'latest', 'y', 'm',
  ]);
  const markers = new Set<string>();
  for (const config of configs) {
    const tokens = [config.command ?? '', ...(config.args ?? [])];
    for (const token of tokens) {
      const t = token.trim();
      if (!t || t.startsWith('-')) continue;
      // 路径取basename（F:\Python3.13\python.exe → python.exe）
      const base = t.split(/[\\/]/).pop() ?? t;
      const word = base.toLowerCase();
      if (generic.has(word) || generic.has(word.replace(/\.(exe|cmd|bat)$/i, ''))) continue;
      // @版本后缀去掉：npx 包名@latest 与包内二进制名保持一致匹配
      const marker = word.split('@')[0];
      if (marker.length >= 5) markers.add(marker);
    }
  }
  return [...markers];
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
}

async function enumerateProcesses(): Promise<ProcessInfo[]> {
  const script =
    "Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine | " +
    "ConvertTo-Json -Compress -Depth 2";
  const { stdout } = await execAsync(
    `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
    { timeout: 20_000, windowsHide: true },
  );
  const parsed = JSON.parse(stdout) as
    | Array<{ ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string }>
    | { ProcessId: number; ParentProcessId: number; Name?: string; CommandLine?: string };
  const list = Array.isArray(parsed) ? parsed : [parsed];
  // PowerShell 输出 PascalCase，映射到内部小写字段
  return list.map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name ?? '',
    cmdline: p.CommandLine ?? '',
  }));
}

/**
 * 清扫孤儿 MCP 子进程。返回击杀的进程数（仅日志用途，失败不抛出）。
 */
export async function sweepOrphanedMcpProcesses(configs: MCPConfig[]): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const markers = deriveMarkers(configs);
  if (markers.length === 0) return 0;

  let processes: ProcessInfo[];
  try {
    processes = await enumerateProcesses();
  } catch (err) {
    logger.warn('orphan sweep skipped (process enumeration failed)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const alivePids = new Set(processes.map((p) => p.pid));
  const relevantNames = /^(node|python\d*|cmd)\.exe$/i;
  const victims: ProcessInfo[] = [];

  for (const proc of processes) {
    if (!relevantNames.test(proc.name ?? '')) continue;
    const cmdline = (proc.cmdline ?? '').toLowerCase();
    if (!markers.some((m) => cmdline.includes(m))) continue;
    // 父进程已死亡 → 本进程为孤儿树的成员（父活着则属于某个在跑的实例）
    if (alivePids.has(proc.ppid)) continue;
    victims.push(proc);
  }

  if (victims.length === 0) return 0;

  // 从最深层开始杀：父进程被 taskkill /T 连带后，子进程再杀会报"不存在"，忽略即可
  let killed = 0;
  for (const victim of victims) {
    try {
      await execAsync(`taskkill /F /T /PID ${victim.pid}`, { windowsHide: true, timeout: 10_000 });
      killed++;
      logger.info('orphaned MCP process killed', { pid: victim.pid, name: victim.name });
    } catch {
      // 父进程先被杀时子进程已随之退出
    }
  }
  if (killed > 0) {
    logger.info(`orphan sweep done: ${killed} processes killed`);
  }
  return killed;
}

/**
 * 清扫孤儿 watchdog 及其目标进程树（通用兜底，不依赖 MCP 配置）。
 *
 * watchdog 守护进程（lifecycle/watchdog.ts 挂载）命令行带
 * `hyacinth-wd:<childPid>` 特征；若其父进程已死（主进程被强杀）而
 * watchdog 尚未完成杀树，则：
 *   1. 先按标记解析出的 childPid 杀目标进程树（防目标残留）
 *   2. 再杀 watchdog 自身
 */
export async function sweepOrphanedWatchdogs(): Promise<number> {
  if (process.platform !== 'win32') return 0;

  let processes: ProcessInfo[];
  try {
    processes = await enumerateProcesses();
  } catch (err) {
    logger.warn('watchdog sweep skipped (process enumeration failed)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const alivePids = new Set(processes.map((p) => p.pid));
  const markRe = new RegExp(`${WATCHDOG_MARK}:(\\d+)`);
  const targets: Array<{ watchdogPid: number; childPid: number }> = [];

  for (const proc of processes) {
    if ((proc.name ?? '').toLowerCase() !== 'node.exe') continue;
    const m = markRe.exec(proc.cmdline ?? '');
    if (!m) continue;
    // 父进程存活 → watchdog 仍受管（可能是当前在跑实例的守护），跳过
    if (alivePids.has(proc.ppid)) continue;
    targets.push({ watchdogPid: proc.pid, childPid: Number(m[1]) });
  }

  if (targets.length === 0) return 0;

  let killed = 0;
  for (const { watchdogPid, childPid } of targets) {
    if (childPid > 0) {
      killProcessTreeSync(childPid); // 先杀目标树（防残留）
      killed++;
    }
    try {
      await execAsync(`taskkill /F /T /PID ${watchdogPid}`, { windowsHide: true, timeout: 10_000 });
      killed++;
    } catch {
      // watchdog 可能已在杀树后自行退出
    }
    logger.info('orphaned watchdog target killed', { watchdogPid, childPid });
  }
  return killed;
}

/**
 * 通用孤儿子进程清扫入口：MCP 特征串模式 + watchdog 标记模式。
 * 供 gateway 启动时调用（覆盖历史强杀残留 + 上次会话未收尾的守护进程）。
 */
export async function sweepOrphanedProcesses(configs: MCPConfig[]): Promise<number> {
  let total = 0;
  total += await sweepOrphanedMcpProcesses(configs);
  total += await sweepOrphanedWatchdogs();
  return total;
}
