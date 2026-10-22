import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
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
 * 安装目录：~/.agent/mcp-servers/{name}/
 * 版本索引：~/.agent/mcp-installed.json
 *
 * 安全升级：新版本先下载到 {name}.new/，成功后再替换 {name}/，失败则保留旧版。
 */
export class MCPInstallManager {
  private installed: InstalledIndex;
  private indexFilePath: string;
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(os.homedir(), '.agent', 'mcp-servers');
    this.indexFilePath = path.join(os.homedir(), '.agent', 'mcp-installed.json');
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

  /**
   * 校验「包名[+版本]」规格，拒绝任何 shell 元字符。
   *
   * ⚠️ C-20/N-04（2026-10-22 修复）：原先把 pkgSpec 直接插进 shell 字符串
   * （`npm install ${pkgSpec}`、`"${pip}" install ${pkgSpec}`，无引号无转义）
   * ⇒ mcp.json 的 package 字段可注入任意命令。
   *
   * 为什么不能"改成 execFileSync 就完事"：本机实测 Windows 上 execFileSync 跑不了 npm
   * （`npm` → ENOENT、`npm.cmd` → EINVAL —— Node 不允许无 shell 启动 .cmd/.bat）。
   * ⇒ npm 分支改用 **node 直接执行 npm-cli.js**（纯参数数组，不经过 shell）；
   *   pip 分支是绝对路径的真实 .exe，可直接 execFileSync。
   * 两条路径都再加一层白名单校验兜底（字符集刻意不含 `; & | $ \` > < " ' 空格 括号`）。
   */
  private assertSafePkgSpec(kind: 'npm' | 'python', spec: string): void {
    const npmRe = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~*+-]+)?$/;
    const pipRe = /^[A-Za-z0-9][A-Za-z0-9._-]*([=!~]=?[A-Za-z0-9.*+-]+)?$/;
    const re = kind === 'npm' ? npmRe : pipRe;
    if (!re.test(spec)) {
      throw new Error(
        `[mcp] 非法的 ${kind} 包规格 "${spec}"：只允许「包名[@版本]」，且不含 shell 元字符`,
      );
    }
  }

  /** 定位 npm-cli.js（用 node 直接执行，避开 Windows 的 .cmd 限制与 shell 拼接） */
  private resolveNpmCli(): string | null {
    const candidates = [
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? null;
  }

  private installNpm(packageName: string, version: string, dir: string): void {
    const pkgSpec = version === 'latest' ? packageName : `${packageName}@${version}`;
    this.assertSafePkgSpec('npm', pkgSpec);

    const npmCli = this.resolveNpmCli();
    if (npmCli) {
      const run = (args: string[]) =>
        execFileSync(process.execPath, [npmCli, ...args], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
      run(['init', '-y']);
      run(['install', pkgSpec, '--no-audit', '--no-fund']);
      return;
    }
    // 兜底：找不到 npm-cli.js（罕见）⇒ 仍走 shell，但规格已被白名单校验
    logger.warn(`npm-cli.js not found next to ${process.execPath}, falling back to shell exec`);
    execSync('npm init -y', { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    execSync(`npm install ${pkgSpec} --no-audit --no-fund`, { cwd: dir, stdio: 'pipe', timeout: 120_000 });
  }

  private installPython(packageName: string, version: string, dir: string): void {
    execSync('python -m venv venv', { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    const isWin = process.platform === 'win32';
    const pip = isWin ? path.join(dir, 'venv', 'Scripts', 'pip.exe') : path.join(dir, 'venv', 'bin', 'pip');
    const pkgSpec = version === 'latest' ? packageName : `${packageName}==${version}`;
    this.assertSafePkgSpec('python', pkgSpec);
    // pip 是绝对路径的真实可执行文件 ⇒ execFileSync 直接传参，不经过 shell
    execFileSync(pip, ['install', pkgSpec], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
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
