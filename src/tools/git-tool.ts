import type { Tool } from './interface.js';
import { GitManager } from '../evolution/git-manager.js';

/**
 * GitTool — 在 Agent 工作目录中执行 Git 版本控制操作
 *
 * 支持 4 个 subcommand：
 * - commit:  暂存所有变更并提交
 * - revert:  先 stash 当前变更，再 revert 指定 commit
 * - branch:  创建并切换到新分支
 * - diff:    获取变更差异（支持 --stat 模式）
 *
 * 不在 Git 仓库中时返回友好提示。
 * commit message 自动附加 session/turn 信息便于追溯。
 */
export class GitTool implements Tool {
  readonly name = 'git';
  readonly description = 'Git version control: commit, revert, branch, diff';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['commit', 'revert', 'branch', 'diff'],
        description: 'Git action to execute',
      },
      message: {
        type: 'string',
        description: 'Commit message (required for commit action)',
      },
      commit: {
        type: 'string',
        description: 'Commit hash to revert (required for revert action)',
      },
      name: {
        type: 'string',
        description: 'Branch name (required for branch action)',
      },
      stat: {
        type: 'boolean',
        description: 'Show diff stat instead of full diff (optional, for diff action)',
      },
      turn: {
        type: 'number',
        description: 'Current turn number, appended to commit message for traceability',
      },
    },
    required: ['action'],
  };

  private gitManager: GitManager;
  private sessionId?: string;

  constructor(gitManager: GitManager, sessionId?: string) {
    this.gitManager = gitManager;
    this.sessionId = sessionId;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    // 检查是否为 Git 仓库
    if (!(await this.gitManager.isRepo())) {
      return '当前工作目录不在 Git 仓库中';
    }

    switch (action) {
      case 'commit': {
        const message = args.message as string;
        if (!message) {
          return "Error: 'message' parameter is required for commit action";
        }

        const turn = args.turn as number | undefined;
        let fullMessage = message;
        if (this.sessionId || turn !== undefined) {
          const tags: string[] = [];
          if (this.sessionId) {
            tags.push(`session:${this.sessionId}`);
          }
          if (turn !== undefined) {
            tags.push(`turn:${turn}`);
          }
          fullMessage += ` [${tags.join(' ')}]`;
        }

        const hash = await this.gitManager.commit(fullMessage);
        return hash ? `Committed: ${hash}` : 'Committed (no hash returned)';
      }

      case 'revert': {
        const commit = args.commit as string;
        if (!commit) {
          return "Error: 'commit' parameter is required for revert action";
        }

        await this.gitManager.stash();
        const result = await this.gitManager.revertCommit(commit);
        return result || 'Revert completed';
      }

      case 'branch': {
        const name = args.name as string;
        if (!name) {
          return "Error: 'name' parameter is required for branch action";
        }

        await this.gitManager.createBranch(name);
        return `Created and switched to branch: ${name}`;
      }

      case 'diff': {
        const stat = args.stat as boolean | undefined;
        if (stat) {
          const result = await this.gitManager.diffStat();
          return result || 'No changes';
        } else {
          const result = await this.gitManager.diff();
          return result || 'No changes';
        }
      }

      default:
        return `Error: Unknown action '${action}'. Available actions: commit, revert, branch, diff`;
    }
  }
}
