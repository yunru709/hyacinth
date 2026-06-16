import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from './interface.js';

/**
 * DiskUsageTool — 磁盘空间与目录大小分析。
 *
 * 不走 bash 沙箱，直接用系统原生方式获取数据：
 * - Windows: PowerShell 脚本 → Get-CimInstance / Get-ChildItem
 * - Unix: du / df 命令
 *
 * 参数：
 * - path: 目标目录，默认当前工作目录
 * - top: 展示前 N 项，默认 20
 * - depth: 递归深度（1=仅直接子项，0=不限制），默认 1
 * - mode: "free" | "dirs" | "files" | "all"，默认 "all"
 */
export class DiskUsageTool implements Tool {
  readonly name = 'disk_usage';
  readonly description =
    'Analyze disk space and directory sizes. Mode "free" shows drive/volume free space. Mode "dirs" ranks subdirectories by total size. Mode "files" ranks individual files. Mode "all" shows both.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Target directory. Default: current working directory.',
      },
      top: {
        type: 'number',
        description: 'Show top N largest items. Default: 20. Max: 200.',
      },
      depth: {
        type: 'number',
        description: 'Recursion depth for directory size calculation. 1 = direct children only, 0 = unlimited. Default: 1.',
      },
      mode: {
        type: 'string',
        description: '"free" = drive free space, "dirs" = rank subdirectories by size, "files" = rank files by size, "all" = dirs + files + free space. Default: "all".',
      },
    },
    required: [],
  };

  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const targetPath = (args.path as string) ?? this.cwd;
    const top = Math.min((args.top as number) ?? 20, 200);
    const depth = (args.depth as number) ?? 1;
    const mode = (args.mode as string) ?? 'all';

    const isWin = process.platform === 'win32';

    if (isWin) {
      return this.executeWindows(targetPath, top, depth, mode);
    }
    return this.executeUnix(targetPath, top, depth, mode);
  }

  // ── Windows ────────────────────────────────────────────────────────

  private executeWindows(targetPath: string, top: number, depth: number, mode: string): Promise<string> {
    const script = this.buildWindowsScript(targetPath, top, depth, mode);
    return this.runPowerShell(script);
  }

  private buildWindowsScript(targetPath: string, top: number, depth: number, mode: string): string {
    const lines: string[] = [
      '$ErrorActionPreference = "Stop"',
      `$target = "${targetPath.replace(/\\/g, '\\\\')}"`,
      `$top = ${top}`,
      `$depth = ${depth}`,
      `$mode = "${mode}"`,
      '',
    ];

    // "free" or "all" → show drive info
    if (mode === 'free' || mode === 'all') {
      lines.push(
        '# ── 驱动器空间 ──',
        '$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {',
        '  $sizeGB  = if ($_.Size) { [math]::Round($_.Size/1GB, 1) } else { 0 }',
        '  $freeGB  = if ($_.FreeSpace) { [math]::Round($_.FreeSpace/1GB, 1) } else { 0 }',
        '  $usedGB  = $sizeGB - $freeGB',
        '  $pctFree = if ($sizeGB -gt 0) { [math]::Round($freeGB/$sizeGB*100, 1) } else { 0 }',
        '  [PSCustomObject]@{ Drive=$_.DeviceID; TotalGB=$sizeGB; UsedGB=$usedGB; FreeGB=$freeGB; PctFree=$pctFree }',
        '}',
        'if ($disks) {',
        '  "--- Drive Free Space ---"',
        '  $disks | Format-Table Drive, TotalGB, UsedGB, FreeGB, PctFree -AutoSize | Out-String | ForEach-Object { $_.TrimEnd() }',
        '} else {',
        '  "No fixed drives found."',
        '}',
        '',
      );
    }

    // "dirs" or "all" → rank subdirectories by total size
    if (mode === 'dirs' || mode === 'all') {
      lines.push(
        '# ── 目录大小排名 ──',
        'if (Test-Path $target) {',
        '  $recurseDepth = if ($depth -eq 0) { $null } else { $depth }',
        '  $dirs = Get-ChildItem $target -Directory -ErrorAction SilentlyContinue | ForEach-Object {',
        '    $size = (Get-ChildItem $_.FullName -Recurse' + (depth === 0 ? '' : ' -Depth ($recurseDepth - 1)') + ' -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum',
        '    $sizeMB = if ($size) { [math]::Round($size/1MB, 1) } else { 0 }',
        '    [PSCustomObject]@{ Name=$_.Name; SizeMB=$sizeMB }',
        '  } | Sort-Object SizeMB -Descending | Select-Object -First $top',
        '  if ($dirs) {',
        '    "`n--- Directories by Size ---"',
        '    $dirs | Format-Table Name, @{N="SizeMB";E={$_.SizeMB};Width=12} -AutoSize | Out-String | ForEach-Object { $_.TrimEnd() }',
        '  } else {',
        '    "`nNo subdirectories found in target."',
        '  }',
        '} else {',
        '  "Path not found: $target"',
        '}',
        '',
      );
    }

    // "files" or "all" → rank files by size
    if (mode === 'files' || mode === 'all') {
      lines.push(
        '# ── 文件大小排名 ──',
        'if (Test-Path $target) {',
        '  $files = Get-ChildItem $target -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First $top | ForEach-Object {',
        '    $sizeMB = if ($_.Length) { [math]::Round($_.Length/1MB, 1) } else { 0 }',
        '    [PSCustomObject]@{ Name=$_.Name; SizeMB=$sizeMB }',
        '  }',
        '  if ($files) {',
        '    "`n--- Files by Size (top $top) ---"',
        '    $files | Format-Table Name, @{N="SizeMB";E={$_.SizeMB};Width=12} -AutoSize | Out-String | ForEach-Object { $_.TrimEnd() }',
        '  } else {',
        '    "`nNo files found in target."',
        '  }',
        '}',
        '',
      );
    }

    return lines.join('\n');
  }

  private runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-du-'));
      const psFile = path.join(tmpDir, 'script.ps1');
      fs.writeFileSync(psFile, `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}\n`, 'utf-8');

      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', psFile,
      ], {
        cwd: this.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, 120000); // 2 min timeout for disk scans

      child.on('close', (code) => {
        clearTimeout(timer);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else if (code === 0) {
          resolve('No output — the target path may be empty or inaccessible.');
        } else {
          reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        reject(new Error(`Failed to start PowerShell: ${err.message}`));
      });
    });
  }

  // ── Unix ───────────────────────────────────────────────────────────
  // 不用 shell 管道，spawn 直接调命令，Node 侧排序取 top N

  private executeUnix(targetPath: string, top: number, depth: number, mode: string): Promise<string> {
    return new Promise((resolve) => {
      const parts: string[] = [];
      let remaining = 0;
      let done = false;

      const finish = () => {
        if (done) return;
        resolve(parts.join('\n') || 'No output.');
        done = true;
      };

      const addSegment = (label: string, content: string) => {
        if (content.trim()) {
          parts.push(`--- ${label} ---\n${content.trim()}`);
        }
      };

      // df — disk free space (no sorting needed)
      if (mode === 'free' || mode === 'all') {
        remaining++;
        const df = spawn('df', ['-h', targetPath], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        df.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
        df.on('close', () => { addSegment('Disk Free Space', out); remaining--; if (remaining === 0) finish(); });
        df.on('error', () => { remaining--; if (remaining === 0) finish(); });
      }

      // du — directory sizes, sort by size desc, take top N
      if (mode === 'dirs' || mode === 'all') {
        remaining++;
        const maxDepth = depth === 0 ? undefined : `--max-depth=${depth}`;
        const duArgs = ['-h', targetPath];
        if (maxDepth) duArgs.unshift(maxDepth);
        const du = spawn('du', duArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        du.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
        du.on('close', () => {
          const sorted = this.sortDuOutput(out, top);
          addSegment(`Directories by Size (top ${top})`, sorted);
          remaining--;
          if (remaining === 0) finish();
        });
        du.on('error', () => { remaining--; if (remaining === 0) finish(); });
      }

      // find — files by size, sort desc, take top N
      if (mode === 'files' || mode === 'all') {
        remaining++;
        const find = spawn('find', [targetPath, '-maxdepth', '1', '-type', 'f', '-printf', '%s\t%p\n'], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        find.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
        find.on('close', () => {
          const sorted = this.sortFindOutput(out, top);
          addSegment(`Files by Size (top ${top})`, sorted);
          remaining--;
          if (remaining === 0) finish();
        });
        find.on('error', () => { remaining--; if (remaining === 0) finish(); });
      }

      if (remaining === 0) finish();
    });
  }

  /** 解析 du -h 输出并按大小降序取前 N */
  private sortDuOutput(raw: string, top: number): string {
    const lines = raw.trim().split('\n').filter(Boolean);
    const parsed = lines.map(line => {
      const m = line.match(/^(\S+)\s+(.+)/);
      if (!m) return { sizeRaw: line, sizeBytes: 0, path: line };
      const sizeStr = m[1];
      return { sizeRaw: sizeStr, sizeBytes: this.parseHumanSize(sizeStr), path: m[2], line };
    });
    parsed.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return parsed.slice(0, top).map(p => p.line).join('\n');
  }

  /** 解析 find -printf '%s\t%p' 输出并按大小降序取前 N */
  private sortFindOutput(raw: string, top: number): string {
    const lines = raw.trim().split('\n').filter(Boolean);
    const parsed = lines.map(line => {
      const idx = line.indexOf('\t');
      if (idx < 0) return { sizeBytes: 0, label: line };
      const sizeBytes = parseInt(line.substring(0, idx), 10) || 0;
      const fpath = line.substring(idx + 1);
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
      return { sizeBytes, label: `${sizeMB.padStart(10)} MB  ${fpath}` };
    });
    parsed.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return parsed.slice(0, top).map(p => p.label).join('\n');
  }

  /** 解析 du -h 的人类可读大小 (K/M/G) → 字节数 */
  private parseHumanSize(s: string): number {
    const m = s.match(/^([\d.]+)\s*([KMGT]?)/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const unit = (m[2] || '').toUpperCase();
    const mult: Record<string, number> = { '': 1, K: 1024, M: 1024**2, G: 1024**3, T: 1024**4 };
    return Math.round(num * (mult[unit] || 1));
  }
}
