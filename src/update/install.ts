import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { migrateLegacyDist, releaseDir } from './releases.js';
import { GUARDIAN_ENV } from '../supervisor/protocol.js';

export function findExtractedDir(tmpDir: string): string {
  const entries = fs.readdirSync(tmpDir).filter(e => e !== 'release.zip');
  if (entries.length !== 1) return tmpDir;

  const sub = path.join(tmpDir, entries[0]);
  return fs.statSync(sub).isDirectory() ? sub : tmpDir;
}

export interface StageReleaseOptions {
  /** 当前运行版本（作为回退基线 lastGood） */
  currentVersion: string;
  onStatus: (msg: string) => void;
}

export interface StageReleaseResult {
  version: string;
  depChanged: boolean;
}

/**
 * 把新版本完整落盘到 releases/<version>/，不动运行中的安装。
 *
 * 任何一步失败（落盘 / 依赖安装）都抛错，由调用方决定不切指针 ——
 * 旧版本（releases/<currentVersion> 或扁平 dist）继续运行。
 *
 * 依赖变化时在版本目录内执行 pnpm install（新依赖只进版本目录，
 * installDir/node_modules 保持不动）；失败则把 installDir/package.json
 * 恢复为旧版本并重装旧依赖自愈，然后抛错。
 */
export function stageRelease(
  extractedDir: string,
  installDir: string,
  opts: StageReleaseOptions,
): StageReleaseResult {
  const newDist = path.join(extractedDir, 'dist');
  const newPkg = path.join(extractedDir, 'package.json');
  if (!fs.existsSync(newDist) || !fs.existsSync(newPkg)) {
    throw new Error('下载的包缺少 dist/ 或 package.json');
  }

  const newPkgJson = JSON.parse(fs.readFileSync(newPkg, 'utf-8')) as {
    version?: string;
    dependencies?: Record<string, unknown>;
  };
  const version = newPkgJson.version ?? opts.currentVersion;
  const dst = releaseDir(installDir, version);

  // 首次迁移：尚无 releases 基线时把当前 dist 固化为 lastGood（回退的地基）
  migrateLegacyDist(installDir, opts.currentVersion);

  // 新版本完整落盘（全新目录，失败不影响现有版本；重装同版本时先清目标内旧产物）
  fs.mkdirSync(dst, { recursive: true });
  fs.rmSync(path.join(dst, 'dist'), { recursive: true, force: true });
  fs.cpSync(newDist, path.join(dst, 'dist'), { recursive: true });
  fs.cpSync(newPkg, path.join(dst, 'package.json'));

  // 依赖变化 → 在版本目录内安装
  const oldPkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, unknown>;
  };
  const depChanged = JSON.stringify(oldPkg.dependencies) !== JSON.stringify(newPkgJson.dependencies);
  if (depChanged) {
    opts.onStatus('依赖有变化，重装中...');
    try {
      execSync('pnpm install --prod --no-frozen-lockfile', { cwd: dst, stdio: 'inherit' });
    } catch (err) {
      // 恢复 installDir 的 package.json（releases/<currentVersion> 即备份），并重装旧依赖自愈
      opts.onStatus('新依赖安装失败，恢复旧版本...');
      fs.cpSync(
        path.join(releaseDir(installDir, opts.currentVersion), 'package.json'),
        path.join(installDir, 'package.json'),
      );
      try {
        execSync('pnpm install --prod --no-frozen-lockfile', { cwd: installDir, stdio: 'inherit' });
      } catch {
        // 自愈失败：旧 package.json 已恢复，报错交给调用方（升级中止，旧版可继续运行）
      }
      throw err instanceof Error ? err : new Error('依赖安装失败');
    }
  } else {
    opts.onStatus('依赖无变化，跳过重装');
  }

  return { version, depChanged };
}

/** 冒烟验证超时（ms） */
export const SMOKE_TIMEOUT_MS = 30_000;

/**
 * 冒烟：spawn 新版入口 `--version`，验证可加载 + 版本号正确。
 * 必须排在依赖安装之后；失败返回 false（调用方不切指针）。
 * 真实启动校验（首启即崩）由 guardian 的 pending 回退兜底。
 */
export function smokeTestRelease(installDir: string, version: string): boolean {
  const entry = path.join(releaseDir(installDir, version), 'dist', 'index.js');
  if (!fs.existsSync(entry)) return false;
  try {
    const res = spawnSync(process.execPath, [entry, '--version'], {
      timeout: SMOKE_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 直接 parse --version 退出，避免再经过 guardian 层（少一层进程加载）
      env: { ...process.env, [GUARDIAN_ENV]: '1' },
    });
    if (res.error || res.status !== 0) return false;
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    return out.includes(version);
  } catch {
    return false;
  }
}
