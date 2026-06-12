import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { SkillDefinition } from '../types.js';
import type { SkillRegistry } from '../skills/registry.js';
import { loadSkillFile, scanSkillsDir } from '../skills/loader.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('hot-reload:skill-watcher');

export interface SkillWatcherDeps {
  skillRegistry: SkillRegistry;
  cwd?: string;
  debounceMs: number;
  /** 文件 skill 加载/重载后的回调，用于补注册 ContextSource 等 */
  onSkillLoaded?: (skill: SkillDefinition) => void;
}

/**
 * 监视 skills 目录（用户级 + 项目级）的 .md 文件变更，自动重新加载 skill
 *
 * 监视目录：
 * - ~/.agent/skills/
 * - <cwd>/.agent/skills/（如果提供了 cwd）
 */
export function watchSkills(deps: SkillWatcherDeps): fs.FSWatcher[] {
  const { skillRegistry, cwd, debounceMs } = deps;

  const dirs: string[] = [];
  const userSkillsDir = path.join(homedir(), '.agent', 'skills');
  dirs.push(userSkillsDir);

  if (cwd) {
    const projectSkillsDir = path.join(cwd, '.agent', 'skills');
    dirs.push(projectSkillsDir);
  }

  // 先做一次初始扫描
  for (const dir of dirs) {
    const loaded = scanSkillsDir(dir, skillRegistry);
    if (loaded.length > 0) {
      logger.info(`Loaded ${loaded.length} skill(s) from ${dir}: ${loaded.join(', ')}`);
      // 为初始扫描到的文件 skill 补注册 ContextSource
      if (deps.onSkillLoaded) {
        for (const name of loaded) {
          const skill = skillRegistry.get(name);
          if (skill) deps.onSkillLoaded(skill);
        }
      }
    }
  }

  const watchers: fs.FSWatcher[] = [];

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* 忽略 */ }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    logger.info(`Watching skills directory: ${dir}`);

    const watcher = fs.watch(dir, { recursive: false }, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const filePath = path.join(dir, filename!);
        const skillName = filename!.replace(/\.md$/, '');

        try {
          fs.accessSync(filePath);
          // 文件存在 → 重新加载
          const skill = loadSkillFile(filePath);
          if (skill) {
            if (skillRegistry.has(skill.name)) {
              skillRegistry.unregister(skill.name);
            }
            skillRegistry.register(skill);
            deps.onSkillLoaded?.(skill);
            logger.info(`Skill reloaded: ${skill.name} (from ${filename})`);
          }
        } catch {
          if (skillRegistry.has(skillName)) {
            skillRegistry.unregister(skillName);
            logger.info(`Skill unregistered: ${skillName} (file removed)`);
          }
        }
      }, debounceMs);
    });

    watcher.on('error', (err) => {
      logger.warn(`Skill watcher error on ${dir}: ${err.message}`, { error: err.message });
    });

    watchers.push(watcher);
  }

  return watchers;
}