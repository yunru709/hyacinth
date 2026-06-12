import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function findExtractedDir(tmpDir: string): string {
  const entries = fs.readdirSync(tmpDir).filter(e => e !== 'release.zip');
  if (entries.length !== 1) return tmpDir;

  const sub = path.join(tmpDir, entries[0]);
  return fs.statSync(sub).isDirectory() ? sub : tmpDir;
}

export function installUpdate(
  extractedDir: string,
  installDir: string,
  onStatus: (msg: string) => void,
): void {
  const newDist = path.join(extractedDir, 'dist');
  const newPkg = path.join(extractedDir, 'package.json');

  if (!fs.existsSync(newDist) || !fs.existsSync(newPkg)) {
    throw new Error('下载的包缺少 dist/ 或 package.json');
  }

  // 替换 dist
  const dstDist = path.join(installDir, 'dist');
  fs.rmSync(dstDist, { recursive: true, force: true });
  fs.cpSync(newDist, dstDist, { recursive: true });

  // 检查依赖变化
  const oldPkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf-8'));
  const newPkgJson = JSON.parse(fs.readFileSync(newPkg, 'utf-8'));
  if (JSON.stringify(oldPkg.dependencies) !== JSON.stringify(newPkgJson.dependencies)) {
    fs.cpSync(newPkg, path.join(installDir, 'package.json'));
    onStatus('依赖有变化，重装中...');
    execSync('pnpm install --prod --no-frozen-lockfile', { cwd: installDir, stdio: 'inherit' });
  } else {
    onStatus('依赖无变化，跳过重装');
  }
}
