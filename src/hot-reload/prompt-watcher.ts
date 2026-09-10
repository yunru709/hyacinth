import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearPromptCache, getPromptsDir } from '../prompts/loader.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

export interface PromptWatcherDeps {
  debounceMs: number;
}

/**
 * 监听 prompts 目录（内置 + ~/.agent/prompts）的 .md 变更 → 清空 prompt 缓存。
 */
export function watchPrompts(deps: PromptWatcherDeps): WatcherHandle[] {
  const externalPromptsDir = path.join(os.homedir(), '.agent', 'prompts');

  return createWatcher({
    name: 'prompt-watcher',
    debounceMs: deps.debounceMs,
    recursive: true,
    filter: (filename) => filename.endsWith('.md'),
    paths: () => {
      const dirs = [getPromptsDir()];
      if (fs.existsSync(externalPromptsDir)) dirs.push(externalPromptsDir);
      return dirs;
    },
    reload: ({ filename }) => {
      clearPromptCache();
      // filename 透传日志（原行为），骨架已记录 error 场景
      if (filename) return;
    },
  });
}
