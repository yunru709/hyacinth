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
    'Compress or extract archives (zip, tar.gz, tar.bz2). ' +
    'Action "extract" unpacks to a target directory. ' +
    'Action "compress" creates an archive from a source directory or file list. ' +
    'Uses system tools (tar, zip) for reliable operation.';
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
      return this.execCommand('tar', ['-xf', archiveFile, '-C', destDir],
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
      return this.execCommand('tar', ['-czf', outputFile, '-C', sourceDir, sourceName],
        `Created ${outputFile}`);
    } else if (ext.endsWith('.tar.bz2') || ext.endsWith('.tbz2')) {
      return this.execCommand('tar', ['-cjf', outputFile, '-C', sourceDir, sourceName],
        `Created ${outputFile}`);
    } else if (ext.endsWith('.tar')) {
      return this.execCommand('tar', ['-cf', outputFile, '-C', sourceDir, sourceName],
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
      const child = spawn(cmd, args, {
        shell: process.platform === 'win32',
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
