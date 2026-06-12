import fs from 'node:fs';
import path from 'node:path';
import { clearPromptCache, getPromptsDir } from '../prompts/loader.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('hot-reload:prompt-watcher');

export interface PromptWatcherDeps {
  debounceMs: number;
}

export function watchPrompts(deps: PromptWatcherDeps): fs.FSWatcher[] {
  const promptsDir = getPromptsDir();
  const externalPromptsDir = path.join(process.cwd(), '.agent', 'prompts');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watchers: fs.FSWatcher[] = [];

  const handleChange = (_eventType: string, filename: string | null) => {
    if (!filename || !filename.endsWith('.md')) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      clearPromptCache();
      logger.info(`Prompt cache cleared due to file change: ${filename}`);
    }, deps.debounceMs);
  };

  logger.info(`Watching prompts directory: ${promptsDir}`);
  const internalWatcher = fs.watch(promptsDir, { recursive: true }, handleChange);
  internalWatcher.on('error', (err) => {
    logger.warn(`Prompt watcher error: ${err.message}`, { error: err.message });
  });
  watchers.push(internalWatcher);

  if (fs.existsSync(externalPromptsDir)) {
    logger.info(`Watching external prompts directory: ${externalPromptsDir}`);
    const externalWatcher = fs.watch(externalPromptsDir, { recursive: true }, handleChange);
    externalWatcher.on('error', (err) => {
      logger.warn(`External prompt watcher error: ${err.message}`, { error: err.message });
    });
    watchers.push(externalWatcher);
  }

  return watchers;
}