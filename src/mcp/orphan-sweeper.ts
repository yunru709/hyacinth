// ============================================================
// 孤儿 MCP 子进程清扫器
// ============================================================
// 背景：后端被外部强杀（Windows TerminateProcess，如 taskkill /F、
// 任务管理器、agent 会话清理）时，'exit' 钩子无法拦截，其 stdio 型
// MCP 子进程树会整体变成孤儿常驻（每棵 6 个进程量级）。
//
// 策略：MCPSystem.start() 连接前执行一次清扫 ——
//   枚举本机 node/python/cmd 进程，满足【命令行匹配当前配置中某个
//   MCP Server 的特征串】且【父进程已死亡】的，判定为孤儿，按进程树
//   taskkill /F /T。父进程存活的进程（其他在跑实例的子树）不受影响。
//
// 安全约束：特征串从配置 args 推导（如 chrome-devtools-mcp、
// windows_mcp），排除 npx/node/serve 等通用词；宁可漏杀不误杀。
// 仅 Windows 执行（Unix 上孤儿由 init 收养，且 detached 进程组已可用）。
// ============================================================

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logging/logger.js';
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
