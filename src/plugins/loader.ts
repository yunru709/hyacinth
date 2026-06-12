import fs from 'node:fs/promises';
import path from 'node:path';
import type { PluginManifest } from './types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('plugin-loader');

/**
 * 插件加载器
 *
 * 负责扫描插件目录、加载 plugin.json manifest、dynamic import 入口模块。
 * 搜索路径（按优先级）：
 *   1. <projectDir>/.agent/plugins/<plugin-id>/
 *   2. <projectDir>/plugins/                        （内置/开发用）
 */
export class PluginLoader {
  constructor(private projectDir: string) {}

  /**
   * 扫描所有候选目录，返回发现的 manifest 列表
   */
  async discover(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    // 搜索路径
    const searchDirs = [
      path.join(this.projectDir, '.agent', 'plugins'),
      path.join(this.projectDir, 'plugins'),
    ];

    for (const dir of searchDirs) {
      const found = await this.scanDirectory(dir);
      manifests.push(...found);
    }

    return manifests;
  }

  /**
   * 扫描单个目录下的所有插件子目录
   */
  private async scanDirectory(dir: string): Promise<PluginManifest[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: PluginManifest[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(dir, entry.name, 'plugin.json');
        try {
          const content = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(content) as PluginManifest;
          // 确保 id 与目录名一致（可选约定）
          if (!manifest.id) manifest.id = entry.name;
          results.push(manifest);
        } catch {
          // 无 plugin.json 或解析失败，跳过
        }
      }

      return results;
    } catch {
      // 目录不存在或无权限
      return [];
    }
  }

  /**
   * 加载 manifest 指向的入口模块
   * 返回模块的 default export（应为 PluginDefinition）
   */
  async loadEntryModule<T>(manifest: PluginManifest): Promise<T | null> {
    // 查找插件目录
    const pluginDir = await this.resolvePluginDir(manifest);
    if (!pluginDir) return null;

    const entryPath = path.resolve(pluginDir, manifest.entry);

    try {
      // file:// URL for Windows compatibility with dynamic import
      // pathToFileURL handles Windows drive letters (C:\) correctly
      const { pathToFileURL } = await import('node:url');
      const url = pathToFileURL(entryPath).href;
      const mod = await import(url);
      return (mod.default ?? mod) as T;
    } catch (error) {
      logger.warn(
        'Failed to load plugin entry module',
        { pluginId: manifest.id, error: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
  }

  /**
   * 获取插件目录的绝对路径
   */
  async getPluginDir(manifest: PluginManifest): Promise<string | null> {
    return this.resolvePluginDir(manifest);
  }

  /**
   * 读取插件配置文件（.agent/plugins.config.json）
   */
  async loadPluginConfig(): Promise<Record<string, Record<string, unknown>>> {
    const configPath = path.join(this.projectDir, '.agent', 'plugins.config.json');
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      return (parsed?.plugins ?? {}) as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  }

  /**
   * 解析插件目录位置
   */
  private async resolvePluginDir(manifest: PluginManifest): Promise<string | null> {
    const candidates = [
      path.join(this.projectDir, '.agent', 'plugins', manifest.id),
      path.join(this.projectDir, 'plugins', manifest.id),
    ];

    for (const dir of candidates) {
      try {
        const stat = await fs.stat(dir);
        if (stat.isDirectory()) return dir;
      } catch {
        // 不存在，继续
      }
    }

    return null;
  }
}