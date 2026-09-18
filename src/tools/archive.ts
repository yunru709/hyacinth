import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

/**
 * ArchiveTool — 解压/压缩 zip、tar.gz、tar.bz2 归档。
 *
 * 解压时使用系统自带命令（Windows tar / Unix tar+unzip）。
 * 压缩时创建 tar.gz 或 zip。
 */
export class ArchiveTool implements Tool {
  readonly name = 'archive';
  readonly description =
    '压缩或解压文件（支持 zip、tar.gz、tar.bz2）。action="extract" 解压到目标目录。action="compress" 将源文件/目录打包为压缩文件。使用系统工具（tar / zip）确保可靠性。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'extract (unpack an archive) or compress (create an archive)',
        enum: ['extract', 'compress'],
      },
      file: {
        type: 'string',
        description: 'Path to the archive file. For extract: the file to unpack. For compress: the output archive path.',
      },
      target: {
        type: 'string',
        description: 'For extract: directory to extract into (default: same dir as archive). For compress: source file/directory to compress.',
      },
    },
    required: ['action', 'file'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const file = args.file as string;
    const target = args.target as string | undefined;

    if (!action || !file) return 'Error: action and file are required.';

    const cwd = process.cwd();
    const absFile = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const absTarget = target ? (path.isAbsolute(target) ? target : path.resolve(cwd, target)) : undefined;

    if (action === 'extract') {
      return this.extract(absFile, absTarget);
    } else if (action === 'compress') {
      if (!absTarget) return 'Error: target is required for compress action.';
      return this.compress(absFile, absTarget);
    }
    return `Error: Unknown action "${action}". Use extract or compress.`;
  }

  /**
   * 解析要用的 tar 及其附加参数（结果缓存，每进程只探测一次）。
   *
   * 缺陷背景（2026-09-19，用户在 Git Bash 环境复现，本机亦以同法复现）：
   * 原先直接 spawn('tar') 从 **PATH** 解析 —— 而 Windows 上 PATH 里 tar 有两个来源：
   *   · C:\Windows\System32\tar.exe（bsdtar，Win10+ 自带）—— **认盘符** ✓
   *   · MSYS/Git Bash 的 GNU tar（装了 Git 的开发者 PATH 里常排在前面）—— 把 `C:\...`
   *     当成**远程主机** ⇒ `Cannot connect to C: resolve failed` / Child returned status 128 ✗
   * 于是同一份代码"在只装了 System32 那版的机器上全绿、在 Git Bash 机器上全挂"。
   *
   * 修法（双保险）：
   *   ① win32 且 System32\tar.exe 存在 → **优先用它**（确定性的 bsdtar，认盘符）；
   *   ② 否则用 PATH 里的 tar，并探测它是否为 GNU —— 是则附加 `--force-local`，
   *      让 GNU tar 把 C:\ 当本地路径而非主机名。
   *      （**只对 GNU 加**：bsdtar 不认 `--force-local`，无条件加会把它弄坏 ✗）
   */
  private tarPromise?: Promise<{ cmd: string; extra: string[] }>;

  private resolveTar(): Promise<{ cmd: string; extra: string[] }> {
    this.tarPromise ??= (async () => {
      if (process.platform === 'win32') {
        const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        if (fs.existsSync(sys)) return { cmd: sys, extra: [] };
      }
      const gnu = await this.isGnuTar('tar');
      return { cmd: 'tar', extra: gnu ? ['--force-local'] : [] };
    })();
    return this.tarPromise;
  }

  /** 探测某个 tar 是否为 GNU tar（bsdtar 的 --version 输出不含 "GNU tar"） */
  private isGnuTar(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(cmd, ['--version'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', () => resolve(out.includes('GNU tar')));
      child.on('error', () => resolve(false));
    });
  }

  /** 跑 tar —— 命令与附加参数一律经 resolveTar 决定 */
  private async execTar(args: string[], okPrefix: string): Promise<string> {
    const { cmd, extra } = await this.resolveTar();
    return this.execCommand(cmd, [...extra, ...args], okPrefix);
  }

  private async extract(archiveFile: string, targetDir?: string): Promise<string> {
    if (!fs.existsSync(archiveFile)) {
      return `Error: Archive file not found: ${archiveFile}`;
    }

    const destDir = targetDir ?? path.join(path.dirname(archiveFile),
      path.basename(archiveFile).replace(/\.(tar\.gz|tar\.bz2|tgz|tbz2|tar|zip)$/i, ''));
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const ext = path.basename(archiveFile).toLowerCase();

    if (ext.endsWith('.tar.gz') || ext.endsWith('.tgz') || ext.endsWith('.tar.bz2') || ext.endsWith('.tbz2') || ext.endsWith('.tar')) {
      return this.execTar(['-xf', archiveFile, '-C', destDir],
        `Extracted to ${destDir}`);
    } else if (ext.endsWith('.zip')) {
      // Try PowerShell on Windows, unzip on Unix
      if (process.platform === 'win32') {
        return this.execCommand('powershell', [
          '-Command',
          `Expand-Archive -Path "${archiveFile}" -DestinationPath "${destDir}" -Force`,
        ], `Extracted to ${destDir}`);
      }
      return this.execCommand('unzip', ['-o', archiveFile, '-d', destDir],
        `Extracted to ${destDir}`);
    }
    return `Error: Unsupported archive format. Use .zip, .tar.gz, .tar.bz2, or .tar`;
  }

  private async compress(outputFile: string, source: string): Promise<string> {
    if (!fs.existsSync(source)) {
      return `Error: Source not found: ${source}`;
    }

    const parentDir = path.dirname(outputFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const sourceName = path.basename(source);
    const sourceDir = path.dirname(source);
    const ext = outputFile.toLowerCase();

    if (ext.endsWith('.tar.gz') || ext.endsWith('.tgz')) {
      return this.execTar(['-czf', outputFile, '-C', sourceDir, sourceName],
        `Created ${outputFile}`);
    } else if (ext.endsWith('.tar.bz2') || ext.endsWith('.tbz2')) {
      return this.execTar(['-cjf', outputFile, '-C', sourceDir, sourceName],
        `Created ${outputFile}`);
    } else if (ext.endsWith('.tar')) {
      return this.execTar(['-cf', outputFile, '-C', sourceDir, sourceName],
        `Created ${outputFile}`);
    } else if (ext.endsWith('.zip')) {
      if (process.platform === 'win32') {
        return this.execCommand('powershell', [
          '-Command',
          `Compress-Archive -Path "${source}" -DestinationPath "${outputFile}" -Force`,
        ], `Created ${outputFile}`);
      }
      return this.execCommand('zip', ['-r', outputFile, sourceName],
        `Created ${outputFile}`);
    }
    return `Error: Unsupported archive format. Use .zip, .tar.gz, .tar.bz2, or .tar`;
  }

  private execCommand(cmd: string, args: string[], okPrefix: string): Promise<string> {
    return new Promise((resolve) => {
      // 绝对路径命令不必经 shell —— 而且经 shell 会破坏含空格的路径（tar 现在总是绝对路径）
      const needShell = process.platform === 'win32' && !path.isAbsolute(cmd);
      const child = spawn(cmd, args, {
        shell: needShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(okPrefix);
        } else {
          resolve(`Error: ${cmd} exited with code ${code}. ${stderr.slice(0, 500)}`);
        }
      });
      child.on('error', (err) => {
        resolve(`Error: Cannot run ${cmd}: ${err.message}. Is it installed?`);
      });
    });
  }
}
