import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { MCPConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('mcp:install');

interface InstalledEntry {
  name: string;
  packageType: 'npm' | 'python';
  package: string;
  version: string;
  installPath: string;
}

interface InstalledIndex {
  servers: Record<string, InstalledEntry>;
}

/**
 * MCPInstallManager — 统一管理 MCP Server 的下载、版本检测和安全升级。
 *
 * 安装目录：.agent/mcp-servers/{name}/
 * 版本索引：.agent/mcp-installed.json
 *
 * 安全升级：新版本先下载到 {name}.new/，成功后再替换 {name}/，失败则保留旧版。
 */
export class MCPInstallManager {
  private installed: InstalledIndex;
  private indexFilePath: string;
  private baseDir: string;

  constructor(private cwd: string) {
    this.baseDir = path.join(cwd, '.agent', 'mcp-servers');
    this.indexFilePath = path.join(cwd, '.agent', 'mcp-installed.json');
    this.installed = this.loadIndex();
  }

  /**
   * 确保 MCP Server 已安装。返回解析后的 command 和 args。
   * 若不需要安装（本地命令或 SSE），直接返回原 command/args。
   */
  async ensureInstalled(config: MCPConfig): Promise<{ command: string; args?: string[] } | null> {
    if (!config.packageType) {
      return this.verifyLocal(config);
    }

    const targetVersion = config.packageVersion || 'latest';
    const entry = this.installed.servers[config.name];

    if (entry && entry.version === targetVersion) {
      logger.info(`MCP "${config.name}" already installed (${targetVersion}), skipping`);
      return this.getEntryCommand(config.name);
    }

    return this.install(config, targetVersion);
  }

  // ── 内部方法 ──

  private async install(config: MCPConfig, version: string): Promise<{ command: string; args?: string[] } | null> {
    const name = config.name;
    const serverDir = path.join(this.baseDir, name);
    const tempDir = path.join(this.baseDir, `${name}.new`);

    logger.info(`Installing MCP "${name}" (${config.packageType}:${config.package}@${version})`);

    try {
      // 清理上次失败的临时目录
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempDir, { recursive: true });

      if (config.packageType === 'npm') {
        this.installNpm(config.package!, version, tempDir);
      } else if (config.packageType === 'python') {
        this.installPython(config.package!, version, tempDir);
      } else {
        logger.warn(`Unknown packageType: ${config.packageType}`);
        return null;
      }

      // 原子替换
      if (fs.existsSync(serverDir)) {
        fs.rmSync(serverDir, { recursive: true, force: true });
      }
      fs.renameSync(tempDir, serverDir);

      const entry: InstalledEntry = { name, packageType: config.packageType, package: config.package!, version, installPath: serverDir };
      this.installed.servers[name] = entry;
      this.saveIndex();

      logger.info(`MCP "${name}" installed (${version})`);
      return this.getEntryCommand(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Install failed for "${name}": ${msg}, keeping previous version`);

      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* 清理失败不阻塞 */ }

      const oldEntry = this.installed.servers[name];
      if (oldEntry) {
        logger.info(`Using cached version of "${name}" (${oldEntry.version})`);
        return this.getEntryCommand(name);
      }
      return null;
    }
  }

  private installNpm(packageName: string, version: string, dir: string): void {
    const pkgSpec = version === 'latest' ? packageName : `${packageName}@${version}`;
    execSync('npm init -y', { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    execSync(`npm install ${pkgSpec} --no-audit --no-fund`, { cwd: dir, stdio: 'pipe', timeout: 120_000 });
  }

  private installPython(packageName: string, version: string, dir: string): void {
    execSync('python -m venv venv', { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    const isWin = process.platform === 'win32';
    const pip = isWin ? path.join(dir, 'venv', 'Scripts', 'pip.exe') : path.join(dir, 'venv', 'bin', 'pip');
    const pkgSpec = version === 'latest' ? packageName : `${packageName}==${version}`;
    execSync(`"${pip}" install ${pkgSpec}`, { cwd: dir, stdio: 'pipe', timeout: 120_000 });
  }

  private getEntryCommand(name: string): { command: string; args?: string[] } | null {
    const entry = this.installed.servers[name];
    if (!entry) return null;

    const dir = entry.installPath;
    const isWin = process.platform === 'win32';

    if (entry.packageType === 'npm') {
      // 从 node_modules/.bin/ 发现入口
      const binDir = path.join(dir, 'node_modules', '.bin');
      const binName = entry.package.split('/').pop()!;
      const ext = isWin ? '.cmd' : '';
      const binPath = path.join(binDir, binName + ext);
      if (fs.existsSync(binPath)) {
        return { command: binPath };
      }
      // 兜底：列出 .bin 中第一个可执行文件
      if (fs.existsSync(binDir)) {
        const bins = fs.readdirSync(binDir).filter(f => f.endsWith(ext));
        if (bins.length > 0) {
          return { command: path.join(binDir, bins[0]) };
        }
      }
      logger.warn(`No binary found for npm package "${entry.package}" in ${binDir}`);
      return null;
    }

    if (entry.packageType === 'python') {
      const py = isWin
        ? path.join(dir, 'venv', 'Scripts', 'python.exe')
        : path.join(dir, 'venv', 'bin', 'python');
      return { command: py, args: ['-m', entry.package] };
    }

    return null;
  }

  private verifyLocal(config: MCPConfig): { command: string; args?: string[] } | null {
    if (!config.command) return null;
    return { command: config.command, args: config.args };
  }

  private loadIndex(): InstalledIndex {
    try {
      if (fs.existsSync(this.indexFilePath)) {
        const raw = fs.readFileSync(this.indexFilePath, 'utf-8');
        return JSON.parse(raw) as InstalledIndex;
      }
    } catch { /* 文件损坏则重新开始 */ }
    return { servers: {} };
  }

  private saveIndex(): void {
    try {
      fs.writeFileSync(this.indexFilePath, JSON.stringify(this.installed, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('Failed to save install index', { error: (err as Error).message });
    }
  }
}
