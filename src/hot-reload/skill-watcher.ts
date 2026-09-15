import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { SkillDefinition } from '../types.js';
import type { SkillRegistry } from '../skills/registry.js';
import { loadSkillFile, scanSkillsDir } from '../skills/loader.js';
import { createLogger } from '../logging/logger.js';
import { createWatcher, type WatcherHandle, type WatchTrigger } from './watcher-base.js';

export interface SkillWatcherDeps {
  skillRegistry: SkillRegistry;
  cwd?: string;
  debounceMs: number;
  /** 文件 skill 加载/重载后的回调，用于补注册 ContextSource 等 */
  onSkillLoaded?: (skill: SkillDefinition) => void;
}

/**
 * 监视全局 skills 目录（~/.agent/skills）的 .md 文件变更，自动重新加载 skill：
 * P-Config 收敛：技能统一走全局（个人助手定位，不再按项目隔离）。
 * 文件存在 → loadSkillFile 重载；文件已删除 → unregister。
 */
export function watchSkills(deps: SkillWatcherDeps): WatcherHandle[] {
  const logger = createLogger('hot-reload:skill-watcher');
  const { skillRegistry } = deps;

  const dirs = [path.join(homedir(), '.agent', 'skills')];

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

  function reloadSkill({ filename, dir }: WatchTrigger): void {
    if (!filename) return;
    const filePath = path.join(dir, filename);
    const skillName = filename.replace(/\.md$/, '');
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
      }
    } catch {
      if (skillRegistry.has(skillName)) {
        skillRegistry.unregister(skillName);
        logger.info(`Skill unregistered: ${skillName} (file removed)`);
      }
    }
  }

  return createWatcher({
    name: 'skill-watcher',
    debounceMs: deps.debounceMs,
    paths: () => dirs,
    filter: (filename) => filename.endsWith('.md'),
    reload: reloadSkill,
  });
}
