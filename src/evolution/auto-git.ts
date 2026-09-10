/**
 * AutoGit — git 自管理策略层（Supervisor 方案 S4）。
 *
 * Supervisor 收口的运维关注点之一，但物理上属于 evolution 层（方案红线 5）：
 * 它只消费 GitManager 原语做**策略编排**，不实现任何 git 能力。
 *
 * 三个策略点：
 *  1. **回合收尾提交**（`autoGit.postTurnCommit`，默认关）：onTurnEnd 观察者——
 *     工作区脏则 commit `auto: post-turn-N`，与 TurnRecorder 的 pre-turn 锚点
 *     配对，使 rollback 落点之间有"成果快照"；
 *  2. **启动处置**（`autoGit.startupAction`，默认 'ignore'）：boot 时对上次
 *     崩溃/中断留下的脏工作区按配置收编（commit 锚点 / stash / 忽略），
 *     防止脏态污染本轮回滚锚点；
 *  3. **快照备份**（`createBackup`）：git bundle + tag 双保险，把手工 cp 备份
 *     固化为一条命令（cli `hyacinth backup <label>`）。
 *
 * 所有策略动作失败只记日志不抛出——git 自管理是增益能力，绝不阻塞对话回合。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { GitManager } from './git-manager.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('auto-git');

/** AutoGit 依赖的配置面（RuntimeConfigCenter 结构兼容） */
export interface AutoGitConfigSource {
  get<T = unknown>(path: string): T;
}

/** 启动处置策略 */
export type StartupAction = 'ignore' | 'commit' | 'stash';

export interface AutoGitOptions {
  gitManager: GitManager;
  configCenter: AutoGitConfigSource;
}

export class AutoGit {
  private readonly gitManager: GitManager;
  private readonly configCenter: AutoGitConfigSource;

  constructor(options: AutoGitOptions) {
    this.gitManager = options.gitManager;
    this.configCenter = options.configCenter;
  }

  /**
   * 回合收尾提交（onTurnEnd 观察者入口）。
   * 配置 `autoGit.postTurnCommit` 默认关闭；开启后工作区脏则提交成果快照。
   */
  async onTurnEnd(turn: number): Promise<void> {
    try {
      const enabled = this.configCenter.get<boolean>('autoGit.postTurnCommit') ?? false;
      if (!enabled) return;

      if (!(await this.gitManager.isRepo())) return;
      if (!(await this.gitManager.hasUncommittedChanges())) return;

      const hash = await this.gitManager.commit(`auto: post-turn-${turn}`);
      logger.info('post-turn snapshot committed', { turn, hash: hash.slice(0, 8) });
    } catch (err) {
      logger.warn('post-turn commit failed (non-blocking)', {
        turn,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 启动处置：boot 时收编上次会话遗留的脏工作区。
   * - 'commit'：提交为启动锚点 `auto: boot-anchor-<timestamp>`；
   * - 'stash'：stash（含未跟踪文件）；stash 失败降级为 ignore（记日志）；
   * - 'ignore'（默认）：不动工作区（回合开始时 TurnRecorder 会按原语义处理）。
   */
  async startupDispose(): Promise<void> {
    try {
      const action = (this.configCenter.get<StartupAction>('autoGit.startupAction') ?? 'ignore') as StartupAction;
      if (action === 'ignore') return;

      if (!(await this.gitManager.isRepo())) return;
      if (!(await this.gitManager.hasUncommittedChanges())) return;

      if (action === 'commit') {
        const hash = await this.gitManager.commit(`auto: boot-anchor-${new Date().toISOString()}`);
        logger.info('dirty worktree committed as boot anchor', { hash: hash.slice(0, 8) });
        return;
      }

      // action === 'stash'
      try {
        await this.gitManager.stash();
        logger.info('dirty worktree stashed at boot');
      } catch (err) {
        logger.warn('boot stash failed, leaving worktree as-is', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      logger.warn('startup dispose failed (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── 装配接线（工厂形态，避免装配层直接 new 业务类 —— P6-4 门禁） ───

/**
 * 装配侧接线（gateway 调用）：new AutoGit + 挂 onTurnEnd 观察者 + 启动处置，
 * 一步完成。挂载经 `register` 回调注入（由调用方用 loop.loopHooks.on 收口，
 * evolution 层因此零 orchestrator 依赖）。失败不抛（策略动作内部已自兜底）。
 */
export async function wireAutoGit(
  register: (handler: (turn: number) => Promise<void>) => void,
  gitManager: GitManager,
  configCenter: AutoGitConfigSource,
): Promise<AutoGit> {
  const autoGit = new AutoGit({ gitManager, configCenter });
  register((turn) => autoGit.onTurnEnd(turn));
  await autoGit.startupDispose();
  return autoGit;
}

// ─── 快照备份 ───────────────────────────────────────────────────────

export interface BackupResult {
  /** bundle 文件绝对路径 */
  bundlePath: string;
  /** 打下的 tag 名（本仓内可 `git checkout` 恢复） */
  tag: string;
}

/**
 * 创建工作区快照：git bundle（单文件全量，可异地恢复）+ tag（仓内双保险）。
 *
 * 仓库根由 `git rev-parse --show-toplevel` 锚定（rev-parse 有向上搜索语义，
 * 从子目录调用时操作目标也是外层仓），bundle 统一落
 * `<仓库根>/.agent/backups/<label>-<timestamp>.bundle`（.agent 不入库）。
 * 不在任何 git 仓内时抛错（调用方给出提示）。
 */
export async function createBackup(
  gitManager: GitManager,
  _cwd: string,
  label: string,
): Promise<BackupResult> {
  let repoRoot: string;
  try {
    const { stdout } = await gitManager.git(['rev-parse', '--show-toplevel']);
    repoRoot = stdout.trim().replace(/\\/g, '/');
  } catch {
    throw new Error('当前目录不在 git 仓库内，无法创建快照（先 `git init` 或到项目根目录运行）');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^\w-]/g, '') || 'backup';
  const backupDir = path.join(repoRoot, '.agent', 'backups');
  mkdirSync(backupDir, { recursive: true });

  const bundlePath = path.join(backupDir, `${safeLabel}-${stamp}.bundle`);
  const tag = `backup-${safeLabel}-${stamp}`;

  // tag 在 bundle 之前打：bundle --all 会把新 tag 一并收录
  await gitManager.git(['tag', '-f', tag]);
  await gitManager.git(['bundle', 'create', bundlePath, '--all']);

  logger.info('backup created', { tag, bundle: bundlePath });
  return { bundlePath, tag };
}
