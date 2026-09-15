import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PluginManifest, PluginDefinition } from './types.js';
import type { HyPlugin } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import { wrapAsHyPlugin, type PluginAdapterDeps } from './plugin-adapter.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('plugin-loader');

/** 破缓存序号：同毫秒内连续重载也能生成不同 URL，避免拿到 ESM 缓存里的旧代码 */
let bustCacheSeq = 0;

/** 插件配置结构（支持 enabled + config） */
export interface PluginConfigEntry {
  /** 是否启用（默认 true，或由 manifest.enabledByDefault 决定） */
  enabled?: boolean;
  /** 插件配置对象 */
  config?: Record<string, unknown>;
}

/**
 * 插件加载器
 *
 * 负责扫描插件目录、加载 plugin.json manifest、dynamic import 入口模块。
 * P-Config 收敛：用户插件统一走全局 ~/.agent/plugins/（个人助手定位，
 * 整个电脑都是操作范围；不再按项目隔离插件安装位置）。
 * 内置/开发插件保留在 <projectDir>/plugins/（随仓库分发）。
 * 搜索路径：
 *   1. ~/.agent/plugins/<plugin-id>/        （用户安装，全局）
 *   2. <projectDir>/plugins/<plugin-id>/    （内置/开发用）
 */
export class PluginLoader {
  constructor(private projectDir: string) {}

  /**
   * 扫描所有候选目录，返回发现的 manifest 列表
   */
  async discover(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    // 搜索路径：全局用户插件 + 仓库内置插件
    const searchDirs = [
      path.join(os.homedir(), '.agent', 'plugins'),
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
  async loadEntryModule<T>(manifest: PluginManifest, bustCache = false): Promise<T | null> {
    const pluginDir = await this.resolvePluginDir(manifest);
    if (!pluginDir) return null;

    const entryPath = path.resolve(pluginDir, manifest.entry);

    try {
      const { pathToFileURL } = await import('node:url');
      let url = pathToFileURL(entryPath).href;
      // 热重载时加时间戳+序号破坏模块缓存，确保读到最新代码
      if (bustCache) url += `?t=${Date.now()}-${++bustCacheSeq}`;
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
   * 目录插件 → HyPlugin 的一体化装载（C 拆出）。
   *
   * 完成「发现 → dynamic import 入口 → 适配为 HyPlugin」的全链路，
   * 产物可直接挂到 PluginHost.mount()。装载失败返回 null。
   */
  async loadHyPlugin(
    manifest: PluginManifest,
    deps: PluginAdapterDeps,
    bustCache = false,
  ): Promise<HyPlugin<Record<string, unknown>, LoopHooks> | null> {
    const definition = await this.loadEntryModule<PluginDefinition>(manifest, bustCache);
    if (!definition) return null;
    return wrapAsHyPlugin(deps, {
      manifest,
      definition,
      status: 'loaded',
      mcpServers: [],
      dir: await this.resolvePluginDir(manifest) ?? '',
    }, {});
  }

  /**
   * 读取插件配置文件（~/.agent/plugins.config.json，全局）
   *
   * P-Config 收敛：插件配置与插件目录一样统一走全局（个人助手定位，
   * 整个电脑都是操作范围）。
   *
   * 支持两种格式：
   * 1. 旧格式：{ "plugins": { "id": { ...config } } }
   * 2. 新格式：{ "plugins": { "id": { "enabled": true, "config": { ... } } } }
   */
  async loadPluginConfig(): Promise<Record<string, PluginConfigEntry>> {
    const configPath = path.join(os.homedir(), '.agent', 'plugins.config.json');
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      const raw = (parsed?.plugins ?? {}) as Record<string, unknown>;
      const result: Record<string, PluginConfigEntry> = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (entry && typeof entry === 'object' && ('enabled' in entry || 'config' in entry)) {
          // 新格式：{ enabled, config }
          result[id] = {
            enabled: (entry as PluginConfigEntry).enabled ?? true,
            config: ((entry as PluginConfigEntry).config ?? {}) as Record<string, unknown>,
          };
        } else {
          // 旧格式：直接是 config 对象
          result[id] = {
            enabled: true,
            config: (entry ?? {}) as Record<string, unknown>,
          };
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  /**
   * 解析插件目录位置（全局 ~/.agent/plugins/<id> 优先，内置 <projectDir>/plugins/<id> 兜底）
   */
  private async resolvePluginDir(manifest: PluginManifest): Promise<string | null> {
    const candidates = [
      path.join(os.homedir(), '.agent', 'plugins', manifest.id),
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