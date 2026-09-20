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
  version: string;
  lastGood: string;
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
