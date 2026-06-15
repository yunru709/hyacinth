import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { DependencyGraph, ImpactResult, FileDependency, SerializedDependencyGraph } from './types.js';
import type { GitManager } from '../evolution/git-manager.js';
import { DependencyParser } from './parser.js';
import { toProjectKey } from '../utils/misc.js';

/** 缓存格式版本号，升级时自动失效重建 */
const CACHE_VERSION = 1;

/** 获取依赖图缓存文件路径 */
function getCachePath(projectKey: string): string {
  return path.join(os.homedir(), '.agent', 'cache', 'dependency-graph', `${projectKey}.json`);
}

/** 计算文件内容的哈希（用于增量更新检测） */
function contentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

export class DependencyAnalyzer {
  private parser = new DependencyParser();
  private graph: DependencyGraph | null = null;
  private fileHashes: Map<string, string> = new Map(); // 绝对路径 → content hash
  private rootDir: string = '';
  private projectKey: string = '';
  private cachePath: string = '';

  /** 分析项目，构建依赖图（优先加载缓存） */
  async analyze(rootDir: string): Promise<DependencyGraph> {
    this.rootDir = rootDir;
    this.projectKey = toProjectKey(rootDir);
    this.cachePath = getCachePath(this.projectKey);

    // 尝试加载缓存
    const cached = await this.loadCache();
    if (cached && cached.rootDir === rootDir) {
      this.graph = this.deserialize(cached);
      this.fileHashes = new Map(Object.entries(cached.fileHashes));
      return this.graph;
    }

    // 缓存不存在或无效，全量构建
    await this.fullBuild();
    return this.graph!;
  }

  /** 全量构建依赖图 */
  private async fullBuild(): Promise<void> {
    const files = await this.parser.scanFiles(this.rootDir);
    const allDeps: FileDependency[] = [];

    for (const file of files) {
      const deps = await this.parser.parseFile(file, this.rootDir);
      allDeps.push(...deps);
      // 计算文件哈希
      try {
        const content = await fs.readFile(file, 'utf-8');
        this.fileHashes.set(file, contentHash(content));
      } catch {
        // 读取失败，跳过哈希
      }
    }

    this.graph = this.buildIndexes(this.rootDir, files, allDeps);
    await this.saveCache();
  }

  /** 增量更新：重新解析变更文件，更新依赖图 */
  async incrementalUpdate(changedFiles?: string[], gitManager?: GitManager): Promise<void> {
    if (!this.graph) return;

    // 如果提供了 gitManager，尝试通过 git diff 获取变更文件列表
    if (gitManager) {
      try {
        const gitChanged = await gitManager.diffNames('HEAD~1');
        if (gitChanged.length > 0) {
          changedFiles = gitChanged;
        }
      } catch {
        // git diff 失败，降级使用传入的 changedFiles
      }
    }

    if (!changedFiles || changedFiles.length === 0) return;

    // 检测哪些文件实际发生了变化
    const actuallyChanged: string[] = [];
    for (const file of changedFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const newHash = contentHash(content);
        const oldHash = this.fileHashes.get(file);
        if (newHash !== oldHash) {
          actuallyChanged.push(file);
          this.fileHashes.set(file, newHash);
        }
      } catch {
        // 文件可能被删除
        actuallyChanged.push(file);
        this.fileHashes.delete(file);
      }
    }

    if (actuallyChanged.length === 0) return;

    // 移除变更文件的旧依赖边
    for (const file of actuallyChanged) {
      this.graph.dependencies = this.graph.dependencies.filter(
        d => d.from !== file
      );
    }

    // 重新解析变更文件
    for (const file of actuallyChanged) {
      try {
        const deps = await this.parser.parseFile(file, this.rootDir);
        this.graph.dependencies.push(...deps);
      } catch {
        // 文件可能不存在，跳过
      }
    }

    // 重新构建索引
    const files = Array.from(this.graph.files);
    // 检查是否有新文件被引入（解析结果中的 to 可能是新文件）
    for (const dep of this.graph.dependencies) {
      files.push(dep.from, dep.to);
    }
    const uniqueFiles = [...new Set(files)];

    this.graph = this.buildIndexes(this.graph.rootDir, uniqueFiles, this.graph.dependencies);
    await this.saveCache();
  }

  /** 构建正向和反向索引 */
  private buildIndexes(rootDir: string, files: string[], allDeps: FileDependency[]): DependencyGraph {
    const dependents = new Map<string, string[]>();
    const dependees = new Map<string, string[]>();
    const fileSet = new Set(files);

    for (const dep of allDeps) {
      const fromList = dependents.get(dep.from) ?? [];
      if (!fromList.includes(dep.to)) fromList.push(dep.to);
      dependents.set(dep.from, fromList);

      const toList = dependees.get(dep.to) ?? [];
      if (!toList.includes(dep.from)) toList.push(dep.from);
      dependees.set(dep.to, toList);
    }

    return { rootDir, files: fileSet, dependencies: allDeps, dependents, dependees };
  }

  /** 查询影响面：修改 file 后，哪些文件会受影响 */
  getImpact(file: string, symbol?: string): ImpactResult {
    if (!this.graph) {
      return { sourceFile: file, symbol, directImpacts: [], indirectImpacts: [], allImpacts: [] };
    }

    const normalizedFile = file.replace(/\\/g, '/');

    const directImpacts: string[] = [];
    const indirectImpacts: string[] = [];
    const visited = new Set<string>();
    const queue: { file: string; depth: number }[] = [{ file: normalizedFile, depth: 0 }];
    visited.add(normalizedFile);

    while (queue.length > 0) {
      const { file: current, depth } = queue.shift()!;
      const dependees = this.graph.dependees.get(current) ?? [];

      for (const dep of dependees) {
        const normalizedDep = dep.replace(/\\/g, '/');
        if (visited.has(normalizedDep)) continue;
        visited.add(normalizedDep);

        if (symbol) {
          const relevantDeps = this.graph.dependencies.filter(
            d => d.from.replace(/\\/g, '/') === normalizedDep && d.symbols.includes(symbol)
          );
          if (relevantDeps.length === 0) continue;
        }

        if (depth === 0) {
          directImpacts.push(normalizedDep);
        } else {
          indirectImpacts.push(normalizedDep);
        }
        queue.push({ file: normalizedDep, depth: depth + 1 });
      }
    }

    return {
      sourceFile: normalizedFile,
      symbol,
      directImpacts,
      indirectImpacts,
      allImpacts: [...directImpacts, ...indirectImpacts],
    };
  }

  /** 获取依赖图（只读） */
  getGraph(): Readonly<DependencyGraph> | null {
    return this.graph;
  }

  /** 获取 projectKey */
  getProjectKey(): string {
    return this.projectKey;
  }

  // ─── 序列化 / 反序列化 ──────────────────────────────────────────

  /** 序列化 DependencyGraph 为可存储的 JSON 格式 */
  private serialize(): SerializedDependencyGraph {
    if (!this.graph) throw new Error('No graph to serialize');

    return {
      version: CACHE_VERSION,
      rootDir: this.graph.rootDir,
      builtAt: new Date().toISOString(),
      files: Array.from(this.graph.files),
      dependencies: this.graph.dependencies,
      dependents: Object.fromEntries(this.graph.dependents),
      dependees: Object.fromEntries(this.graph.dependees),
      fileHashes: Object.fromEntries(this.fileHashes),
    };
  }

  /** 反序列化 JSON 为 DependencyGraph */
  private deserialize(data: SerializedDependencyGraph): DependencyGraph {
    return {
      rootDir: data.rootDir,
      files: new Set(data.files),
      dependencies: data.dependencies,
      dependents: new Map(Object.entries(data.dependents)),
      dependees: new Map(Object.entries(data.dependees)),
    };
  }

  // ─── 缓存读写 ──────────────────────────────────────────────────

  /** 从磁盘加载缓存 */
  private async loadCache(): Promise<SerializedDependencyGraph | null> {
    try {
      const content = await fs.readFile(this.cachePath, 'utf-8');
      const data = JSON.parse(content) as SerializedDependencyGraph;
      // 版本不匹配，缓存无效
      if (data.version !== CACHE_VERSION) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** 保存缓存到磁盘 */
  private async saveCache(): Promise<void> {
    if (!this.graph) return;
    try {
      const dir = path.dirname(this.cachePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.cachePath, JSON.stringify(this.serialize(), null, 2), 'utf-8');
    } catch {
      // 缓存写入失败不影响主流程
    }
  }
}
