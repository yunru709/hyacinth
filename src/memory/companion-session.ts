import fs from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      return this.dir;
    }
    // ── 已存在的目录也要**校正 meta.type**（2026-10-16）──────────────────
    // 本目录按定义就是陪伴会话（位于 ~/.agent/companion/<角色>/），但 meta.json
    // 可能是更早的版本写的 —— 实测：柔柔/meta.json = {"type":"normal"}（2026-09-17），
    // 而 sessionModeOfDir 以 meta.type 为准 ⇒ 陈旧的 type 会让跨模式闸门**拒绝**
    // 把会话切进陪伴（报「该会话属于「normal」模式，当前是「companion」模式」），
    // 表现为陪伴模式彻底进不去。⇒ 只重写 meta.json 这一个文件，**绝不触碰**
    // conversation/events/stats（那是对话数据）。
    this.ensureCompanionMeta();
    return this.dir;
  }

  /**
   * 校正 meta.json 的 `type` 为 companion（仅此一个文件；已正确则不写盘）。
   * 保留其余字段（createdAt / projectKey 等），只改 type。
   */
  private ensureCompanionMeta(): void {
    const metaPath = path.join(this.dir, 'meta.json');
    if (existsSync(metaPath)) {
      try {
        const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as { type?: string } & Record<string, unknown>;
        if (raw && raw.type === 'companion') return; // 已正确 ⇒ 不写盘
        writeFileSync(metaPath, JSON.stringify({ ...raw, type: 'companion' }), 'utf-8');
        logger.warn('Companion session meta.type corrected', {
          dir: this.dir,
          from: raw?.type ?? '(missing)',
        });
      } catch {
        // 损坏 / 不可读 → 重写为最小可用 meta（对话数据不动）
        writeFileSync(metaPath, JSON.stringify({ type: 'companion', createdAt: new Date().toISOString() }), 'utf-8');
        logger.warn('Companion session meta.json rewritten (unreadable)', { dir: this.dir });
      }
    } else {
      writeFileSync(metaPath, JSON.stringify({ type: 'companion', createdAt: new Date().toISOString() }), 'utf-8');
      logger.warn('Companion session meta.json created', { dir: this.dir });
    }
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

  /**
   * 列出所有可用角色（~/.agent/companion/ 下有 persona.md 的目录名）。
   */
  listCharacters(): string[] {
    const base = path.join(os.homedir(), '.agent', 'companion');
    try {
      return readdirSync(base).filter((name) => {
        if (name.startsWith('.')) return false;
        const dir = path.join(base, name);
        return existsSync(dir) && existsSync(path.join(dir, 'persona.md'));
      });
    } catch {
      return [];
    }
  }

  /** 读取上次使用的角色名（.last-character；不存在返回空串） */
  getLastCharacter(): string {
    try {
      return readFileSync(
        path.join(os.homedir(), '.agent', 'companion', '.last-character'), 'utf-8',
      ).trim();
    } catch {
      return '';
    }
  }

  /** 记住本次使用的角色名（写 .last-character；失败静默） */
  setLastCharacter(name: string): void {
    try {
      writeFileSync(
        path.join(os.homedir(), '.agent', 'companion', '.last-character'),
        name, 'utf-8',
      );
    } catch { /* 写入失败不影响 */ }
  }
}
