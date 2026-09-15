// ============================================================
// 子进程树强杀 + 父死自灭 watchdog
// ============================================================
// 背景：Windows 上主进程被外部强杀（TerminateProcess，如终端点叉叉 /
// taskkill /F）时，JS 的 exit/beforeExit 钩子完全不触发，已 spawn 的
// 子进程树（本地模型 / MCP Server / bash 命令）会整体孤儿化常驻。
//
// 两道防线：
//   1. killProcessTreeSync —— 同步三级树杀（taskkill → PowerShell KT
//      递归 → process.kill），供 ProcessManager / BackgroundProcessRegistry
//      / BashTool 共用（消除三处各自实现的重复）。
//   2. spawnWatchdog —— 为每个受管子进程挂一个极小的 node 守护进程，
//      轮询父进程 PID 存活：父死（任意方式）→ 立即杀目标进程树并自杀；
//      目标进程树已正常结束 → 自杀。脚本命令行带 hyacinth-wd:<pid> 特征，
//      若 watchdog 自身也变成孤儿（被系统调度延迟等），由 orphan-sweeper
//      在下次启动时按该特征兜底清扫。
//
// 纯 node:child_process 实现，零依赖，Windows/Unix 双平台。
// ============================================================

import { spawn, spawnSync } from 'node:child_process';

/** watchdog 特征标记：脚本命令行包含 `hyacinth-wd:<childPid>`，供 sweeper 识别 */
export const WATCHDOG_MARK = 'hyacinth-wd';

/**
 * 同步三级树杀（进程树击杀）：
 *   1. taskkill /T /F —— 快路径（树完整且根存活时有效）
 *   2. PowerShell KT 递归 —— 按 ParentProcessId 逐层下探再 Stop-Process，
 *      容忍任意 PID 已消失（含树根已死）；CIM 过滤器用 \" 转义内嵌
 *      （实测经 cmd.exe 可用）
 *   3. process.kill 兜底
 * Unix: process.kill(-pid) 杀进程组
 */
export function killProcessTreeSync(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* 进入下一级 */
  }

  // taskkill 半途失败（status=128：树中某成员已消失即整体报错）的补杀：
  // 按 ParentProcessId 递归找后代再逐个 Stop-Process，容忍任意 PID 消失。
  if (process.platform === 'win32') {
    try {
      const script =
        `& { function KT([int]$p){ ` +
        `Get-CimInstance Win32_Process -Filter \\"ParentProcessId=$p\\" -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { KT ([int]$_.ProcessId) }; ` +
        `try { Stop-Process -Id $p -Force -ErrorAction Stop } catch {} }; ` +
        `KT ${pid} }`;
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', script,
      ], { stdio: 'ignore', windowsHide: true });
      if (r.status === 0) return;
    } catch {
      /* 进入 process.kill 兜底 */
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* 进程已退出 */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 进程已退出 */ }
  }
}

/** 生成自包含 watchdog 脚本（经 spawn argv 传入，不经 shell，引号自由） */
export function buildWatchdogScript(childPid: number): string {
  return [
    `const{spawnSync}=require('child_process');`,
    // 特征标记（供 orphan-sweeper 识别本守护进程及其目标）：
    // 形如 hyacinth-wd:<childPid>，sweeper 按此正则提取目标 pid
    `const MARK='${WATCHDOG_MARK}:${childPid}';`,
    `const PARENT=${process.pid},CHILD=${childPid};`,
    `function alive(p){try{process.kill(p,0);return true}catch{return false}}`,
    `function killTree(p){`,
    `  if(process.platform==='win32'){`,
    `    try{spawnSync('taskkill',['/T','/F','/PID',String(p)],{stdio:'ignore',windowsHide:true})}catch{}`,
    `    try{`,
    `      const s='& { function KT([int]$pp){ Get-CimInstance Win32_Process -Filter \\"ParentProcessId=$pp\\" -ErrorAction SilentlyContinue | ForEach-Object { KT ([int]$_.ProcessId) }; try { Stop-Process -Id $pp -Force -ErrorAction Stop } catch {} }; KT '+p+' }';`,
    `      spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',s],{stdio:'ignore',windowsHide:true})`,
    `    }catch{}`,
    `  }else{`,
    `    try{process.kill(-p,'SIGKILL')}catch{try{process.kill(p,'SIGKILL')}catch{}}`,
    `  }`,
    `}`,
    `const t=setInterval(()=>{`,
    `  if(!alive(PARENT)){clearInterval(t);killTree(CHILD);process.exit(0)}`,
    `  else if(!alive(CHILD)){clearInterval(t);killTree(CHILD);process.exit(0)}`,
    `},1500);`,
    `setTimeout(()=>{clearInterval(t);process.exit(0)},3600000);`,
  ].join('\n');
}

/**
 * 为子进程挂一个父死自灭 watchdog。
 * - 父进程以任意方式死亡（含 TerminateProcess 强杀）→ watchdog 杀掉目标树后自杀
 * - 目标进程树正常结束 → watchdog 兜底清一次后自杀
 * 返回 false 表示 spawn 失败（调用方静默忽略，不强求）。
 */
export function spawnWatchdog(childPid: number): boolean {
  if (!childPid || childPid <= 0) return false;
  try {
    const script = buildWatchdogScript(childPid);
    const wd = spawn(process.execPath, ['-e', script], {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    // 不阻止父进程事件循环退出（父正常 exit 时 watchdog 靠 parent 死亡检测自杀）
    wd.unref();
    return true;
  } catch {
    return false;
  }
}
