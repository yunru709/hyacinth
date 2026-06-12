import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDependency } from './types.js';

const IMPORT_REGEX = /import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_REGEX = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export class DependencyParser {
  /** 解析单个文件的依赖 */
  async parseFile(filePath: string, rootDir: string): Promise<FileDependency[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const deps: FileDependency[] = [];

      // 静态 import
      for (const match of content.matchAll(IMPORT_REGEX)) {
        const symbolsStr = match[1] || match[2] || '';
        const modulePath = match[3];
        const symbols = symbolsStr ? symbolsStr.split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : [];
        const resolved = await this.resolveModule(modulePath, filePath, rootDir);
        if (resolved) {
          deps.push({ from: filePath, to: resolved, importType: 'static', symbols });
        }
      }

      // require
      for (const match of content.matchAll(REQUIRE_REGEX)) {
        const symbolsStr = match[1] || match[2] || '';
        const modulePath = match[3];
        const symbols = symbolsStr ? symbolsStr.split(',').map(s => s.trim().split(/\s*:\s*/)[0].trim()).filter(Boolean) : [];
        const resolved = await this.resolveModule(modulePath, filePath, rootDir);
        if (resolved) {
          deps.push({ from: filePath, to: resolved, importType: 'require', symbols });
        }
      }

      // dynamic import
      for (const match of content.matchAll(DYNAMIC_IMPORT_REGEX)) {
        const modulePath = match[1];
        const resolved = await this.resolveModule(modulePath, filePath, rootDir);
        if (resolved) {
          deps.push({ from: filePath, to: resolved, importType: 'dynamic', symbols: [] });
        }
      }

      return deps;
    } catch {
      return [];
    }
  }

  /** 解析模块路径为绝对路径 */
  private async resolveModule(modulePath: string, fromFile: string, rootDir: string): Promise<string | null> {
    // 只处理相对路径（./ 或 ../）
    if (!modulePath.startsWith('.')) return null;

    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, modulePath);

    // 尝试添加扩展名
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];
    for (const ext of extensions) {
      const withExt = resolved + ext;
      try { await fs.access(withExt); return withExt; } catch {}
    }

    // 尝试 index 文件
    for (const ext of extensions) {
      const indexPath = path.join(resolved, `index${ext}`);
      try { await fs.access(indexPath); return indexPath; } catch {}
    }

    return null;
  }

  /** 递归扫描目录中的所有 .ts/.js/.tsx/.jsx 文件 */
  async scanFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 node_modules, dist, .git, coverage
        if (['node_modules', 'dist', '.git', 'coverage'].includes(entry.name)) continue;
        files.push(...await this.scanFiles(fullPath));
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }

    return files;
  }
}
