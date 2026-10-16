// ============================================================
// 陪伴场景目录监视 —— scene_render 落盘 → 协议事件
// ============================================================
// 为什么需要它（2026-10-16）：
//   场景图（scene.png / scene.json）由**旁路 agent** 的 scene_render 工具写盘
//   （~/.agent/companion/<角色>/），是**被动产物、没有事件源**；而业务核心不得依赖
//   UI 适配层（分层规则 2，见 scripts/verify-layers.mjs）⇒ 无法从 generation 侧
//   直接 emit 协议事件。
//   ⇒ 由 **UI 侧**监视目录，把"文件变化"转成协议事件（UI_EVENT.COMPANION_SCENE），
//     前端据此即时刷新背景 —— 替代 WebUI 此前的 15s 轮询。
//
// 只认「scene.json」这一个信号：它是 scene.png 落盘**之后**才写的元数据
// （见 scene-render.ts 的落盘顺序），因此一次渲染只推一次，不会连推两下。
// ============================================================

import fs from 'node:fs';

export interface CompanionSceneWatchOptions {
  /** 场景根目录（~/.agent/companion/）；其下每个子目录 = 一个角色 */
  root: string;
  /** 场景变更回调（character = 角色子目录名） */
  onChange: (character: string) => void;
  /** 去抖毫秒（默认 200）：scene.png 与 scene.json 先后落盘时合并为一次 */
  debounceMs?: number;
}

export interface CompanionSceneWatchHandle {
  /** 是否真的建立起了监视（false = 降级为空句柄，调用方应据此打日志/兜底） */
  active: boolean;
  /** 停止监视（幂等；句柄为"空"时也安全） */
  close(): void;
}

/** 空句柄：监视不可用时返回它，调用方无需判空 */
const NOOP: CompanionSceneWatchHandle = { active: false, close: () => { /* no-op */ } };

/**
 * 监视 `<root>/<角色>/scene.json` 的变化。
 *
 * **不抛**：根目录不存在 / 平台不支持递归监视 / 句柄创建失败 ⇒ 返回空句柄。
 * 理由：场景背景刷新失败不该影响整个会话（与"读取类依赖缺失即降级"的既有约定一致）。
 */
export function watchCompanionScenes(options: CompanionSceneWatchOptions): CompanionSceneWatchHandle {
  const { root, onChange, debounceMs = 200 } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher;

  try {
    if (!fs.existsSync(root)) return NOOP;
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (!rel.endsWith('scene.json')) return;
      // Windows 下 filename 形如 `柔柔\scene.json`；POSIX 下为 `柔柔/scene.json`
      const character = rel.split(/[\\/]/)[0];
      if (!character) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange(character);
      }, debounceMs);
    });
  } catch {
    return NOOP;
  }

  return {
    active: true,
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        watcher.close();
      } catch {
        /* 已关闭 / 句柄失效：忽略 */
      }
    },
  };
}
