import fs from 'node:fs';
import path from 'node:path';

// ─── 版本目录与指针（升级可回退的基石） ─────────────────────────────
//
// 布局：
//   <install>/releases/
//     current.json                  ← 指针 { version, lastGood }（唯一原子变更点）
//     v<version>/dist/  package.json  ← 每个版本完整落盘，不可变
//
// 原则：升级从不修改运行中版本的文件；指针切换是唯一原子变更点。

export interface ReleasePointer {
  /**
   * 当前 release id。正常升级时是 semver；自构建时是**唯一 buildId**
   * （semver + 时间戳 + git sha），保证同版本重建不会覆盖旧 release。
   */
  version: string;
  /** 上一个**运行稳定**的 release id（不是“上一个版本号”） */
  lastGood: string;
}

/** release 元数据（落 releases/v<buildId>/meta.json；给回退后的自修复留痕） */
export interface ReleaseMeta {
  /** 人类可读 semver（package.json version） */
  version: string;
  /** 唯一 release id（目录名去掉 v 前缀） */
  buildId: string;
  createdAt: string;
  /** 构建时的 git HEAD（无仓库/非 git 时缺省） */
  gitHead?: string;
  /** 构建来源（local-source / github / manual） */
  source?: string;
  /** 额外备注（例如触发它的会话/任务） */
  note?: string;
}

/** 回退留痕（releases/last-rollback.json；guardian 自动回退时写） */
export interface RollbackRecord {
  from: string;
  to: string;
  at: string;
  reason: string;
}

/**
 * 生成唯一 buildId。
 *
 * 为什么不能只用 semver：agent 自改后版本号通常不变（0.9.61），
 * 用 semver 做目录名会把“上一个可运行版本”覆盖掉，lastGood 也会指向自己，
 * guardian 的 `lastGood !== version` 判定直接失效。
 */
export function makeBuildId(version: string, gitHead?: string, now: number = Date.now()): string {
  const base = version.replace(/[^0-9A-Za-z._-]/g, '-');
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
  const sha = (gitHead ?? '').trim().slice(0, 8) || 'local';
  return `${base}-${stamp}-${sha}`;
}

export function releaseExists(installDir: string, buildId: string): boolean {
  return fs.existsSync(releaseDir(installDir, buildId));
}

export function writeReleaseMeta(installDir: string, buildId: string, meta: ReleaseMeta): void {
  const dir = releaseDir(installDir, buildId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

export function readReleaseMeta(installDir: string, buildId: string): ReleaseMeta | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(releaseDir(installDir, buildId), 'meta.json'), 'utf-8'),
    ) as Partial<ReleaseMeta>;
    if (typeof raw.version !== 'string' || typeof raw.buildId !== 'string') return null;
    return {
      version: raw.version,
      buildId: raw.buildId,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      gitHead: typeof raw.gitHead === 'string' ? raw.gitHead : undefined,
      source: typeof raw.source === 'string' ? raw.source : undefined,
      note: typeof raw.note === 'string' ? raw.note : undefined,
    };
  } catch {
    return null;
  }
}

export function writeRollbackRecord(installDir: string, record: RollbackRecord): void {
  fs.mkdirSync(releasesDir(installDir), { recursive: true });
  fs.writeFileSync(
    path.join(releasesDir(installDir), 'last-rollback.json'),
    JSON.stringify(record, null, 2),
    'utf-8',
  );
}

export function readRollbackRecord(installDir: string): RollbackRecord | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(releasesDir(installDir), 'last-rollback.json'), 'utf-8'),
    ) as Partial<RollbackRecord>;
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return null;
    return {
      from: raw.from,
      to: raw.to,
      at: typeof raw.at === 'string' ? raw.at : '',
      reason: typeof raw.reason === 'string' ? raw.reason : '',
    };
  } catch {
    return null;
  }
}

export function releasesDir(installDir: string): string {
  return path.join(installDir, 'releases');
}

export function pointerPath(installDir: string): string {
  return path.join(releasesDir(installDir), 'current.json');
}

export function releaseDir(installDir: string, version: string): string {
  return path.join(releasesDir(installDir), `v${version}`);
}

/**
 * 从入口文件路径解析安装根：<install>/dist/<entry>.js → <install>。
 * 与 cli.ts 既有约定（resolve(dirname(process.argv[1]), '..', '..')）一致。
 */
export function resolveInstallRoot(entryPath: string): string {
  return path.resolve(path.dirname(path.dirname(entryPath)));
}

export function readPointer(installDir: string): ReleasePointer | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerPath(installDir), 'utf-8')) as Partial<ReleasePointer>;
    if (typeof raw.version !== 'string' || typeof raw.lastGood !== 'string') return null;
    return { version: raw.version, lastGood: raw.lastGood };
  } catch {
    return null;
  }
}

/**
 * 原子写指针：先写 tmp 再 rename（Windows 同卷 rename 覆盖目标为原子操作）。
 */
export function writePointerAtomic(installDir: string, pointer: ReleasePointer): void {
  fs.mkdirSync(releasesDir(installDir), { recursive: true });
  const tmp = pointerPath(installDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2));
  fs.renameSync(tmp, pointerPath(installDir));
}

/** 列出已落盘的版本目录名（形如 v0.9.57），排除指针文件。 */
export function listReleases(installDir: string): string[] {
  try {
    return fs.readdirSync(releasesDir(installDir)).filter(n => n.startsWith('v'));
  } catch {
    return [];
  }
}

/**
 * 清理超出保留数的旧版本目录；exclude 中的版本（current/lastGood）永不清。
 * 删除失败可容忍（旧目录仅占磁盘，不影响运行与回退）。
 */
export function pruneReleases(installDir: string, keep = 3, exclude: string[] = []): void {
  const stale = listReleases(installDir)
    .filter(n => !exclude.includes(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const dir of stale.slice(keep)) {
    try {
      fs.rmSync(path.join(releasesDir(installDir), dir), { recursive: true, force: true });
    } catch {
      /* 删除失败可容忍 */
    }
  }
}

/**
 * 首次迁移：当前安装尚无 releases 基线时，把现有 dist + package.json
 * 复制为 <version> 的回退基线。复制而非移动，保证本次升级失败时
 * 运行中的旧安装不受任何影响。
 */
export function migrateLegacyDist(installDir: string, version: string): void {
  const dst = releaseDir(installDir, version);
  if (fs.existsSync(dst)) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(installDir, 'dist'), path.join(dst, 'dist'), { recursive: true });
  fs.cpSync(path.join(installDir, 'package.json'), path.join(dst, 'package.json'));
}
