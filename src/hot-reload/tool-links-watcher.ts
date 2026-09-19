// ============================================================
// 热重载 — 联动清单 watcher（第 15 条）
// ============================================================
// 监听 ~/.agent/tool-links.json：文件一变 → 重新装载"当前清单"（启动时已装载一次）。
//
// 语义全在 utils/tool-links.ts 的 initToolLinksFromDisk 里：
//   · 文件不存在 ⇒ 出厂默认（= 迁移前行为，行为不回退）；
//   · 结构错 / 语义错（事件名不在目录、handler 未注册）⇒ **保旧**并报错。
// 本文件只做两件事：**何时重载**（createWatcher）+ **怎么记日志**。
//
// 分层（verify:layers 规则 4）：本文件对 supervisor **零依赖** —— 访问面（路径 + 装载逻辑）
// 由 gateway 装配层注入（arch-assembly.createToolLinksAccess），与 extension-registry-watcher 同法。
//
// 为什么 poll 而不是 watch：独立配置文件写在 .agent 目录（写入密集），fs.watch 误触发多；
// 且 poll 天然容忍"文件还不存在"（用户还没建过清单）。
//
// 与启动时那次装载的关系：两者**调用同一个函数**（装配层的 createToolLinksAccess 里就是它）
// ⇒ 冷启动与热更的语义**必然一致**，不会出现"启动时严格、热更时宽松"这类分叉。
// ============================================================

import { createLogger } from '../logging/logger.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

const logger = createLogger('tool-links-watcher');

/** 联动清单访问面（gateway 装配层注入：arch-assembly.createToolLinksAccess 的产物） */
export interface ToolLinksAccessLike {
  /** 要监听的路径（目前单一文件；留数组是为将来可能的项目级/多文件） */
  listPaths(): string[];
  /** 重新装载一次（返回是否应用成功 + 错误列表）——原样转给 initToolLinksFromDisk */
  reload(): { applied: boolean; errors: string[]; path: string; existed: boolean };
}

export interface ToolLinksWatcherDeps {
  access: ToolLinksAccessLike;
  debounceMs: number;
}

export function watchToolLinks(deps: ToolLinksWatcherDeps): WatcherHandle[] {
  return createWatcher({
    name: 'tool-links',
    mode: 'poll',
    paths: () => deps.access.listPaths(),
    reload: async () => {
      const r = deps.access.reload();
      if (r.errors.length > 0) {
        // 保旧：initToolLinksFromDisk 已经"不应用"，这里只如实记录原因（不抛）
        logger.warn('联动清单校验失败，保留上一份继续运行', { errors: r.errors, path: r.path });
        return;
      }
      logger.info(
        r.existed ? '联动清单已热更' : '联动清单不存在（使用出厂默认）',
        { path: r.path },
      );
    },
    debounceMs: deps.debounceMs,
  });
}
