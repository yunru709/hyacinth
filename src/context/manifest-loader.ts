// ============================================================
// ManifestLoader — 上下文清单加载器
// ============================================================
//
// 职责：加载 ContextManifest 定义，暴露查询接口。
//
// 加载优先级（P-Config 收敛：项目级已取消，统一走全局）：
//   ~/.agent/context-manifest.json        ← 用户全局覆盖
//   manifest-defaults.ts                  ← 兜底默认（本模块生成）
//
// 与 Composer 的关系：
//   Composer 通过 ManifestLoader 读取 section 列表和 zone 布局。
//   Composer 不直接依赖 manifest-defaults.ts —— 始终走 loader，
//   确保全局覆盖能生效。热重载时 reload() 刷新缓存。
//
// 为什么用 loader 而不是直接 import 默认值：
//   1. 支持用户覆盖（context-manifest.json）
//   2. 热重载（ManifestWatcher 检测文件变更 → reload）
//   3. 单一入口（所有 Zone/Section 查询走同一个实例）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONTEXT_MANIFEST } from './manifest-defaults.js';
import type { ContextManifest, ZoneEntry, SectionEntry } from './manifest-types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('manifest-loader');

const MANIFEST_FILENAME = 'context-manifest.json';

export class ManifestLoader {
  private manifest: ContextManifest | null = null;

  constructor(cwd: string) {
    // P-Config 收敛：项目级已取消，只读全局 ~/.agent/context-manifest.json。
    // 构造参数 cwd 保留仅为调用方兼容，不再用于定位任何项目级文件。
  }

  private get manifestPath(): string {
    return path.join(os.homedir(), '.agent', MANIFEST_FILENAME);
  }

  load(): ContextManifest {
    if (this.manifest) return this.manifest;

    const filePath = this.manifestPath;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid manifest: not a JSON object');
      }

      if (parsed.version !== 1) {
        throw new Error(`Unsupported manifest version: ${parsed.version}. Expected: 1`);
      }

      if (!parsed.zones || typeof parsed.zones !== 'object') {
        throw new Error('Invalid manifest: missing "zones" object');
      }

      for (const [zoneKey, zoneDef] of Object.entries(parsed.zones)) {
        const zone = zoneDef as any;
        if (typeof zone.enabled !== 'boolean') {
          throw new Error(`Invalid zone "${zoneKey}": missing "enabled" boolean`);
        }
        if (!Array.isArray(zone.sections)) {
          throw new Error(`Invalid zone "${zoneKey}": missing "sections" array`);
        }
        for (const section of zone.sections) {
          if (!section.name || !section.source || section.priority == null || !section.type) {
            throw new Error(`Invalid section in zone "${zoneKey}": missing required fields (name, source, priority, type)`);
          }
        }
      }

      this.manifest = parsed as ContextManifest;
      logger.info('context-manifest.json loaded');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.manifest = this.generateDefaults();
      } else if (err instanceof SyntaxError) {
        logger.warn('context-manifest.json parse error, generating defaults', { error: err.message });
        this.manifest = this.generateDefaults();
      } else {
        throw err;
      }
    }

    return this.manifest;
  }

  reload(): ContextManifest {
    this.manifest = null;
    return this.load();
  }

  getZone(name: string): ZoneEntry | undefined {
    const m = this.load();
    return m.zones[name];
  }

  /**
   * 设置 zone 开关并落盘。zone 不存在 → 报错（防误写）。
   * 落盘后 watcher（manifest-watcher）监听文件变化自动 reload，
   * 未跑 watcher 的进程（如 TUI 本地模式）也因内存对象已被修改而即时生效。
   */
  setZoneEnabled(zoneName: string, enabled: boolean): void {
    const m = this.load();
    const zone = m.zones[zoneName];
    if (!zone) {
      throw new Error(`Zone "${zoneName}" not found in context-manifest.json`);
    }
    zone.enabled = enabled;
    this.save();
  }

  /** 落盘当前 manifest（内存对象序列化到 .agent/context-manifest.json） */
  private save(): void {
    if (!this.manifest) return;
    try {
      fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
      fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new Error(`Failed to save context-manifest.json: ${(err as Error).message}`);
    }
  }

  getEnabledZones(): Array<[string, ZoneEntry]> {
    const m = this.load();
    return Object.entries(m.zones)
      .filter(([, zone]) => zone.enabled)
      .sort(([, a], [, b]) => a.order - b.order);
  }

  getSections(zoneName: string): SectionEntry[] {
    const zone = this.getZone(zoneName);
    if (!zone) return [];
    return [...zone.sections].sort((a, b) => a.priority - b.priority);
  }

  getManifest(): ContextManifest {
    return this.load();
  }

  isZoneEnabled(zoneName: string): boolean {
    const zone = this.getZone(zoneName);
    return zone?.enabled ?? false;
  }

  private generateDefaults(): ContextManifest {
    const m = JSON.parse(JSON.stringify(DEFAULT_CONTEXT_MANIFEST)) as ContextManifest;

    try {
      fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
      fs.writeFileSync(this.manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf-8');
      logger.info('Generated default context-manifest.json');
    } catch (err) {
      logger.warn('Failed to write default context-manifest.json', { error: (err as Error).message });
    }

    return m;
  }
}
