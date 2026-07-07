import fs from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('companion-session');

/**
 * 陪伴 session 目录：~/.agent/companion/<角色名>/
 *
 * 按角色隔离：一个角色一个目录，内含 world.json（世界数据）+ 会话文件。
 * 所有渠道（TUI、飞书、HTTP）共享同一份对话。
 * 与正常 session（~/.agent/sessions/）完全分开，不受 SessionManager.cleanup() 影响。
 */
function getCompanionDir(name: string): string {
  return path.join(os.homedir(), '.agent', 'companion', name);
}

/**
 * CompanionSessionManager — 管理陪伴模式专用 session（全局单例）。
 *
 * 每个角色独立目录。进入陪伴模式时根据角色名自动恢复，
 * 重置时仅归档对话文件（conversation/events/stats），不动 world.json。
 */
export class CompanionSessionManager {
  private dir: string = '';

  /** 全局单例 */
  private static instance: CompanionSessionManager;
  static getInstance(): CompanionSessionManager {
    if (!CompanionSessionManager.instance) {
      CompanionSessionManager.instance = new CompanionSessionManager();
    }
    return CompanionSessionManager.instance;
  }

  /** 设置/切换当前角色 */
  setCharacter(name: string): void {
    this.dir = getCompanionDir(name);
  }

  /** 返回当前角色的陪伴目录路径（首次调用时自动创建） */
  getOrCreate(): string {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.initSessionSync();
      logger.info('Created companion session', { dir: this.dir });
    }
    return this.dir;
  }

  /**
   * 重置陪伴 session：仅归档对话文件，不动 world.json（世界数据跨会话保留）。
   */
  async reset(): Promise<string> {
    const archiveRoot = path.join(this.dir, 'sessions-archive');
    await fs.mkdir(archiveRoot, { recursive: true });
    const archiveDir = path.join(archiveRoot, String(Date.now()));
    await fs.mkdir(archiveDir, { recursive: true });

    const sessionFiles = ['conversation.jsonl', 'events.jsonl', 'stats.json'];
    for (const f of sessionFiles) {
      const src = path.join(this.dir, f);
      try {
        await fs.rename(src, path.join(archiveDir, f));
      } catch {
        // 文件不存在则跳过
      }
    }
    logger.info('Archived conversation files', { archiveDir });

    this.initSessionSync();
    logger.info('Created new companion session', { dir: this.dir });

    return this.dir;
  }

  private initSessionSync(): void {
    const now = new Date().toISOString();
    writeFileSync(
      path.join(this.dir, 'meta.json'),
      JSON.stringify({ type: 'companion', createdAt: now }),
      'utf-8',
    );
    writeFileSync(path.join(this.dir, 'conversation.jsonl'), '', 'utf-8');
    writeFileSync(path.join(this.dir, 'events.jsonl'), '', 'utf-8');
    writeFileSync(
      path.join(this.dir, 'stats.json'),
      JSON.stringify({ turns: 0, input_tokens: 0, output_tokens: 0, tool_calls: 0 }),
      'utf-8',
    );
  }
}
