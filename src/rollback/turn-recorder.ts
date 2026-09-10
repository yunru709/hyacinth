/**
 * TurnRecorder — 回合追踪器
 *
 * 在每个回合的生命周期中自动记录文件变更：
 *   - 回合开始 → git commit（生成回滚锚点）
 *   - 工具执行前 → 拦截 write/edit 读取旧内容
 *   - 回合结束 → git diff 补充检测 + 写入 TurnStore
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GitManager } from '../evolution/git-manager.js';
import type { TurnStore } from './turn-store.js';
import type { TurnRecord, ChangedFile } from './types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('turn-recorder');

export class TurnRecorder {
  private currentRecord: TurnRecord | null = null;
  private projectDir: string;
  /** 记录已手动捕获预状态的路径 → 避免 git diff 重复添加 */
  private recordedPaths = new Set<string>();
  /** 上一回合 agent 明确触碰的文件（recordPreState 记录），供下一回合 pre-turn commit 精确提交 */
  private lastTurnAgentPaths: string[] = [];

  constructor(
    private gitManager: GitManager,
    private turnStore: TurnStore,
    projectDir: string,
  ) {
    this.projectDir = projectDir;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** 回合开始时调用。返回 preCommit hash（非 git 时为空字符串） */
  async startTurn(turnId: number): Promise<string> {
    let preCommit = '';

    try {
      if (await this.gitManager.isRepo()) {
        // 回滚锚点 = pre-turn 时的 HEAD 或提交后的新 commit：
        // - 工作树有未提交变更 → 提交生成锚点（变更属于上一回合）
        // - 工作树干净 → 直接用当前 HEAD 作为锚点（git commit 会因
        //   nothing-to-commit 失败，此前每次干净轮次都打一条 warn 噪音）
        const hasChanges = await this.gitManager.hasUncommittedChanges();
        if (hasChanges) {
          logger.debug('Uncommitted changes detected before turn start, committing as previous turn state.');
          // 只提交 agent 上一回合明确触碰的文件（recordPreState 记录），避免把用户
          // 手动改动卷入自动提交；无记录（首回合 / 纯 bash 操作）时回退全量收编。
          const paths = this.lastTurnAgentPaths.length > 0 ? this.lastTurnAgentPaths : undefined;
          preCommit = await this.gitManager.commit(`auto: pre-turn-${turnId}`, paths);
          this.lastTurnAgentPaths = [];
          logger.debug(`Pre-turn commit: ${preCommit.slice(0, 8)} for turn ${turnId}`);
        } else {
          const { stdout } = await this.gitManager.git(['rev-parse', 'HEAD']);
          preCommit = stdout.trim();
          logger.debug(`Pre-turn anchor (clean tree): ${preCommit.slice(0, 8)} for turn ${turnId}`);
        }

        // 打轻量 tag 方便 git log 查找
        try {
          await this.gitManager.git(['tag', '-f', `rollback-turn-${turnId}`]);
        } catch {
          // tag 失败不阻塞
        }
      }
    } catch (err) {
      logger.warn(`Failed to create pre-turn commit for turn ${turnId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // 不阻塞回合
    }

    this.currentRecord = {
      turnId,
      timestamp: new Date().toISOString(),
      preCommit,
      changedFiles: [],
      commands: [],
    };
    this.recordedPaths.clear();

    return preCommit;
  }

  /**
   * 记录文件写操作的前置状态。
   * 在 write / edit / multi_edit 工具执行前调用。
   * @param absolutePath 文件的绝对路径
   */
  recordPreState(absolutePath: string): void {
    if (!this.currentRecord) return;

    // 转为相对于项目目录的路径
    const relPath = this.toRelativePath(absolutePath);

    // 去重：同一个文件可能被多次拦截（如多次 edit），只记录第一次
    if (this.recordedPaths.has(relPath)) return;
    this.recordedPaths.add(relPath);

    const exists = fs.existsSync(absolutePath);
    const entry: ChangedFile = {
      path: relPath,
      action: exists ? 'modified' : 'created',
    };

    if (exists) {
      try {
        entry.oldContent = fs.readFileSync(absolutePath, 'utf-8');
      } catch {
        // 二进制文件或读取失败，不存 oldContent
      }
    }

    this.currentRecord.changedFiles.push(entry);
  }

  /** 记录 bash 命令 */
  recordCommand(command: string): void {
    if (!this.currentRecord) return;
    this.currentRecord.commands.push(command);
  }

  /** 回合结束时调用。补充 git diff 检测 → 写入 TurnStore */
  async endTurn(): Promise<TurnRecord | null> {
    if (!this.currentRecord) return null;

    // 在 git diff 补充检测之前，先保存本回合 agent 明确触碰的文件（recordPreState 记录，
    // 不含 git diff 补充的、可能混入用户手动改动的文件），供下一回合 pre-turn commit 精确提交。
    this.lastTurnAgentPaths = [...this.recordedPaths];

    try {
      // 通过 git diff 补充检测遗漏文件（bash rm 等未被拦截的操作）
      await this.enrichFromGitDiff();
    } catch (err) {
      logger.warn('Failed to enrich turn record from git diff', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const record = { ...this.currentRecord };
    await this.turnStore.save(record);

    logger.debug(`Turn ${record.turnId} recorded: ${record.changedFiles.length} files, ${record.commands.length} commands`);

    this.currentRecord = null;
    this.recordedPaths.clear();
    return record;
  }

  // ── Private ────────────────────────────────────────────────────────

  /** 通过 git diff --name-status 补充检测遗漏的变更文件 */
  private async enrichFromGitDiff(): Promise<void> {
    if (!this.currentRecord || !this.currentRecord.preCommit) return;

    try {
      const isRepo = await this.gitManager.isRepo();
      if (!isRepo) return;

      // git diff --name-status <preCommit>
      const { stdout } = await this.gitManager.git([
        'diff', '--name-status', this.currentRecord.preCommit,
      ]);

      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;

        const statusCode = parts[0];
        const filePath = parts.slice(1).join('\t'); // 文件名可能含空格

        // 跳过已手动记录的路径
        if (this.recordedPaths.has(filePath)) continue;

        const action = statusToAction(statusCode);
        if (!action) continue;

        this.currentRecord.changedFiles.push({
          path: filePath,
          action,
          // 无法获取 oldContent（文件已被修改），git reset 会直接恢复
        });
        this.recordedPaths.add(filePath);
      }
    } catch {
      // diff 失败不阻塞
    }
  }

  /** 绝对路径 → 相对于项目根目录的路径 */
  private toRelativePath(absolutePath: string): string {
    const rel = path.relative(this.projectDir, absolutePath);
    // 规范化路径分隔符
    return rel.replace(/\\/g, '/');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** git diff --name-status 的状态码 → ChangedFile.action */
function statusToAction(code: string): ChangedFile['action'] | null {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'created';
    case 'D':
      return 'deleted';
    // R = renamed, C = copied — 当作 modified（文件内容变化）
    case 'R':
    case 'C':
      return 'modified';
    default:
      return null;
  }
}
