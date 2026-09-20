import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Bootstrap 壳 — 稳定引导入口（package.json bin 指向本文件）。
 *
 * 读 <install>/releases/current.json 指针 → import 对应版本的 dist/index.js。
 * 无 releases 布局（首次部署 / 仓库 dev 直跑）时 fallback import('./index.js')。
 *
 * 契约（跨版本稳定）：壳永远位于 <install>/dist/，且只做"读指针 + 转发"，
 * 不 import 任何业务代码。任何解析失败都 fallback 扁平布局。
 */

export interface BootstrapPointer {
  version: string;
}

/**
 * 解析壳要转发的真实入口绝对路径；解析失败（无 releases 布局 / 指针无效 /
 * 版本目录缺失 / 损坏 JSON）返回 null，调用方 fallback 到扁平入口。
 */
export function resolveBootstrapEntry(installRoot: string): string | null {
  try {
    const pointerFile = path.join(installRoot, 'releases', 'current.json');
    if (!fs.existsSync(pointerFile)) return null;
    const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf-8')) as Partial<BootstrapPointer>;
    if (typeof pointer.version !== 'string') return null;
    const entry = path.join(installRoot, 'releases', `v${pointer.version}`, 'dist', 'index.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const installRoot = path.resolve(path.dirname(path.dirname(process.argv[1])));
  const entry = resolveBootstrapEntry(installRoot);
  await import(entry ? pathToFileURL(entry).href : './index.js');
}

main().catch(err => {
  console.error('[bootstrap] 启动失败:', err);
  process.exit(1);
});
