import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginManager, PluginReloadError } from '../plugins/manager.js';
import { createWatcher, type WatcherHandle, type WatchTrigger } from './watcher-base.js';
import {
  RESTART_AFTER_PLUGIN_EXIT_CODE,
  prepareShellRestart,
  isUnderGuardian,
} from '../supervisor/protocol.js';

interface PluginWatcherDeps {
  pluginManager: PluginManager;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听插件目录变化，自动热更新插件（S3：插件代码热更新闭环）。
 *
 * P-Config 收敛：用户插件走全局，内置插件随仓库。监听：
 *   - ~/.agent/plugins/（用户安装，全局；不存在则创建）
 *   - <cwd>/plugins/（内置/开发用，存在才监听）
 *
 * 变更分发（handlePluginChange）：
 *   - 已激活插件的**代码文件**变更 → 定向 `reloadFromDisk(id)`
 *     （`?t=` 破缓存重 import，失败回滚旧版，插件保持可用）；
 *   - 其他（清单 plugin.json 变更 / 新增目录 / 目录已删 / 未激活插件）→
 *     全量 `loadAll()`（幂等增删 diff）。
 *   - 回滚也失败（宿主不可靠）→ 写会话快照 + 重启原因，`exit(44)` 重启兜底
 *     （重启后从磁盘重新装载；仅当处于 guardian 守护下才升级，否则降级存活只记日志）。
 *
 * 已知边界：清单（plugin.json）变更走全量 loadAll，对已激活插件不重载代码
 * （entry 路径等清单级改动需重启生效）—— 文档化取舍，避免把清单语义混进代码热更新。
 */

// 变更触发的目录是否为插件根目录之一（全局用户插件 / 内置插件）
const PLUGIN_DIRS = (deps: PluginWatcherDeps): string[] => {
  const dirs = [path.join(os.homedir(), '.agent', 'plugins')];
  const builtinDir = path.join(deps.cwd, 'plugins');
  if (fs.existsSync(builtinDir)) dirs.push(builtinDir);
  return dirs;
};

/**
 * 从 watch 触发上下文解析变更涉及的插件 id。
 * watch 模式下 filename 形如 `example-greeter/index.js`，首段即插件目录名；
 * poll 模式（filename=null）无法定位 → null（调用方走全量 loadAll）。
 */
export function resolveChangedPluginId(trigger: WatchTrigger): string | null {
  const { filename } = trigger;
  if (!filename) return null;
  const first = filename.split(/[\\/]/)[0];
  return first && first.length > 0 ? first : null;
}

/**
 * 是否升级为重启兜底：插件热更新回滚失败（宿主不可靠）且处于 guardian 守护下
 * （有兜底接盘，重启后从磁盘重新装载）。无 guardian 时保持存活（降级），只记日志。
 * 抽出为纯函数便于单测（避免在测试中触发 process.exit）。
 */
export function shouldEscalateToRestart(recovered: boolean): boolean {
  return recovered === false && isUnderGuardian();
}

/**
 * 处理一次插件目录变更。导出供单测直接调用（不依赖 fs.watch 时序）。
 *
 * @returns
 *   - 'reloaded'：定向热更新成功
 *   - 'rolled-back'：热更新失败但已回滚旧版（或无可升级的守护），插件保持可用
 *   - 'rescanned'：全量 loadAll（无法定位插件 / 清单变更 / 插件未激活 / 目录已删）
 *   - 'escalated'：回滚失败且可升级 → 已 exit(44)（仅此分支触发进程退出）
 */
export async function handlePluginChange(
  deps: PluginWatcherDeps,
  trigger: WatchTrigger,
): Promise<'reloaded' | 'rolled-back' | 'rescanned' | 'escalated'> {
  const { pluginManager } = deps;
  const pluginId = resolveChangedPluginId(trigger);

  // 无法定位插件 / 清单（plugin.json）变更 → 全量 rescan（幂等 diff）
  if (!pluginId || trigger.filename?.endsWith('plugin.json')) {
    await pluginManager.loadAll();
    return 'rescanned';
  }

  const instance = pluginManager.get(pluginId);
  // 未激活（disabled/error）或插件目录已删除（整体删除）→ 全量 rescan（增删处理）
  if (!instance || instance.status !== 'activated' || !fs.existsSync(instance.dir)) {
    await pluginManager.loadAll();
    return 'rescanned';
  }

  try {
    await pluginManager.reloadFromDisk(pluginId);
    return 'reloaded';
  } catch (error) {
    const reloadErr = error as PluginReloadError;
    if (reloadErr?.recovered === false) {
      if (shouldEscalateToRestart(reloadErr.recovered)) {
        // 回滚也失败 → 宿主不可靠，重启兜底（44）。写会话快照保证重启后恢复。
        prepareShellRestart({
          code: RESTART_AFTER_PLUGIN_EXIT_CODE,
          source: 'plugin-hot-reload',
          detail: `${pluginId}: ${reloadErr.message}`,
        });
        console.error(`[hot-reload] plugin ${pluginId} reload AND rollback failed — restarting (44)`);
        process.exit(RESTART_AFTER_PLUGIN_EXIT_CODE);
        return 'escalated'; // unreachable, 便于类型收口
      }
      // 无 guardian 兜底：宿主已降级，记录醒目错误后保持存活
      console.error(`[hot-reload] plugin ${pluginId} reload AND rollback failed, host degraded: ${reloadErr.message}`);
      return 'rolled-back';
    }
    // recovered=true：已回滚旧版，插件保持可用
    return 'rolled-back';
  }
}

/**
 * 启动插件目录监听。返回统一句柄（HotReloadManager.stop() 可关）。
 */
export function watchPluginsDir(deps: PluginWatcherDeps): WatcherHandle[] {
  const userPluginsDir = path.join(os.homedir(), '.agent', 'plugins');
  try { fs.mkdirSync(userPluginsDir, { recursive: true }); } catch { /* ignore */ }

  return createWatcher({
    name: 'plugins',
    debounceMs: deps.debounceMs,
    paths: () => PLUGIN_DIRS(deps),
    reload: async (trigger) => {
      await handlePluginChange(deps, trigger);
    },
  });
}
