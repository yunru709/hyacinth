// ============================================================
// mode-profile-loader —— 声明式模式加载器
// ============================================================
//
// 扫描 ~/.agent/modes/*.json（全局）+ <cwd>/.agent/modes/*.json（项目覆盖，
// 同名覆盖全局），每个 profile 构造 DeclarativeRouter 并注册进 Router
// 注册表（profiles.ts）。模式名 = session type。
//
// 加载时机：bootstrap-wiring（与其他内置 prompt/目录同步同层）。
// 修改 modes/*.json 后重启生效（watcher 家族接入留待需要时）。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logging/logger.js';
import { registerRouter } from './profiles.js';
import { DeclarativeRouter, type ModeProfile } from './mode-profile.js';

const logger = createLogger('mode-profile');

/** 校验并解析一个 profile JSON（结构不合格返回 undefined 并记日志） */
function parseProfile(file: string, raw: string): ModeProfile | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    logger.warn('mode profile JSON parse failed', { file, error: (err as Error).message });
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const p = obj as Record<string, unknown>;
  const name = path.basename(file, '.json');
  if (typeof p.name === 'string' && p.name !== name) {
    logger.warn('mode profile name mismatch with filename (using filename)', { file, declared: p.name, used: name });
  }
  return { ...(p as unknown as ModeProfile), name };
}

/** 扫描一个目录并注册其中全部 profile；返回注册的模式名 */
function loadFromDir(dir: string, registered: Set<string>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return; // 目录不存在 → 跳过
  }
  for (const f of entries) {
    const file = path.join(dir, f);
    try {
      const profile = parseProfile(file, fs.readFileSync(file, 'utf-8'));
      if (!profile) continue;
      const router = new DeclarativeRouter(profile);
      router.attachOutputProtocol();
      registerRouter(router);
      registered.add(profile.name);
      logger.info('mode profile registered', { mode: profile.name, file });
    } catch (err) {
      logger.warn('mode profile registration failed', { file, error: (err as Error).message });
    }
  }
}

/**
 * 加载声明式模式：全局 ~/.agent/modes/ → 项目 <cwd>/.agent/modes/（同名覆盖）。
 * 幂等：重复调用以最后注册者为准（与注册表语义一致）。
 */
export function loadModeProfiles(cwd: string): string[] {
  const registered = new Set<string>();
  loadFromDir(path.join(os.homedir(), '.agent', 'modes'), registered);
  loadFromDir(path.join(cwd, '.agent', 'modes'), registered);
  return [...registered];
}
