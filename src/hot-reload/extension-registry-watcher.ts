// ============================================================
// 热重载 — 扩展注册表名单 watcher（第 14 个 watcher）
// ============================================================
// 监听两层名单（extension-registry.json：全局 + 项目）变化：
//   1. 重新加载名单并注入运行时 ExtensionRegistry（校验失败跳过应用，保旧值）；
//   2. 插件裁决 diff：名单 enabled 与插件实际挂载态不一致时
//      deactivate / activate —— 即改即生效，无需重启。
// replacements / orders 的运行时重应用需要装配期上下文（分层注册原语），
// 由装配层注入的 applier 处理（可选；未注入时仅记录日志）。
//
// 分层（verify:layers 规则 4）：本文件对 supervisor 只做 **类型引用**（编译期
// 擦除）；名单的读取/路径等值依赖由 gateway 装配层注入（ManifestAccessLike）。
// ============================================================

import type { PluginManager } from '../plugins/manager.js';
import type { ExtensionRegistry, ExtensionManifest } from '../supervisor/extension-registry.js';
import { createLogger } from '../logging/logger.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

const logger = createLogger('extension-registry-watcher');

/** 名单访问面（gateway 装配层注入：arch-assembly.createManifestAccess 的产物） */
export interface ManifestAccessLike {
  /** 两层名单文件路径（全局 + 项目） */
  listManifestPaths(): string[];
  /** 读两层名单并合并校验（宽容解析：非法条目剔除，错误列表返回） */
  loadManifest(): { manifest: ExtensionManifest; errors: string[] };
}

export interface ExtensionRegistryWatcherDeps {
  extensionRegistry: ExtensionRegistry;
  pluginManager: PluginManager;
  /** 名单访问面（gateway 注入；supervisor 值依赖不过业务核心） */
  manifestAccess: ManifestAccessLike;
  debounceMs: number;
  /** 装配层注入：名单变更后的 replacements/orders 运行时重应用（可选） */
  applyDiff?: (prev: ExtensionManifest, next: ExtensionManifest) => Promise<void>;
}

export function watchExtensionRegistry(deps: ExtensionRegistryWatcherDeps): WatcherHandle[] {
  return createWatcher({
    name: 'extension-registry',
    // 独立配置文件走 poll（对齐 config-watcher：.agent 目录写入密集，fs.watch 误触发多）
    mode: 'poll',
    paths: () => deps.manifestAccess.listManifestPaths(),
    reload: async () => {
      const { manifest, errors } = deps.manifestAccess.loadManifest();
// ── [圈三锚点 · 校验先例] ──────────────────────────────────────────────
// 第三圈（联动清单 tool-links.json）接入时，改动落在这里：清单校验的**完整参照**就在这里：失败保旧、成功 diff、单条失败仅 warn
// 触发条件：第二个真实联动用例出现（见 docs/design/tool-linkage-laws.md）
      if (errors.length > 0) {
        logger.warn('名单校验失败，保留旧名单继续运行', { errors });
        return;
      }
      const prev = deps.extensionRegistry.getManifest();
      deps.extensionRegistry.setManifest(manifest);

      // 插件裁决 diff：以「名单声明 vs 实际挂载态」为基准（名单是决定性用户声明）
      const host = deps.pluginManager.getHost();
      for (const decl of manifest.plugins) {
        const mounted = host.isMounted(decl.id);
        try {
          if (!decl.enabled && mounted) {
            await deps.pluginManager.deactivate(decl.id);
            logger.info('名单裁决：插件已停用', { pluginId: decl.id });
          } else if (decl.enabled && !mounted) {
            await deps.pluginManager.activate(decl.id);
            logger.info('名单裁决：插件已启用', { pluginId: decl.id });
          }
        } catch (err) {
          logger.warn('名单裁决应用失败', { pluginId: decl.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (deps.applyDiff) {
        await deps.applyDiff(prev, manifest);
      }
    },
  });
}
