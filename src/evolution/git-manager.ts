import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
  branch?: string;
}

export interface GitContextEntry {
  hash: string;
  message: string;
  date: string;
  branch: string;
  files: string[];
}

export class GitManager {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  // Run git command in repoPath
  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync('git', args, { cwd: this.repoPath, maxBuffer: 10 * 1024 * 1024 });
    } catch (err: any) {
      throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
    }
  }

  // Check if path is a git repo
  async isRepo(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  // Initialize repo: git init, add all, first commit
  async init(): Promise<void> {
    if (await this.isRepo()) return;
    await this.git(['init']);
    await this.git(['add', '-A']);
    await this.git(['commit', '-m', 'Initial agent snapshot']);
  }

  // Stage all and commit, returns commit hash
  async commit(message: string): Promise<string> {
    await this.git(['add', '-A']);
    const { stdout } = await this.git(['commit', '-m', message]);
    const match = stdout.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
    return match ? match[1] : '';
  }

  // Create and switch to new branch
  async createBranch(name: string): Promise<void> {
    await this.git(['checkout', '-b', name]);
  }

  // Checkout a ref (branch, commit, tag)
  async checkout(ref: string): Promise<void> {
    await this.git(['checkout', ref]);
  }

  // Merge a branch into current
  async merge(branch: string): Promise<void> {
    await this.git(['merge', branch, '--no-edit']);
  }

  // Abort a merge in progress
  async abortMerge(): Promise<void> {
    await this.git(['merge', '--abort']);
  }

  // Get diff (optionally against a ref, default unstaged)
  async diff(ref?: string): Promise<string> {
    const args = ['diff'];
    if (ref) args.push(ref);
    const { stdout } = await this.git(args);
    return stdout;
  }

  // Get commit log
  async log(limit: number = 10): Promise<CommitInfo[]> {
    const { stdout } = await this.git(['log', `-${limit}`, '--oneline', '--format=%H|%s|%ai']);
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, ...dateParts] = line.split('|');
      return { hash, message, date: dateParts.join('|') };
    });
  }

  // Hard reset to a ref (rollback)
  async resetHard(ref: string): Promise<void> {
    await this.git(['reset', '--hard', ref]);
  }

  // Get current branch name
  async getCurrentBranch(): Promise<string> {
    const { stdout } = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  // Check for uncommitted changes
  async hasUncommittedChanges(): Promise<boolean> {
    const { stdout } = await this.git(['status', '--porcelain']);
    return stdout.trim().length > 0;
  }

  // Delete a branch
  async deleteBranch(name: string): Promise<void> {
    await this.git(['branch', '-D', name]);
  }

  // Get the repository path
  getRepoPath(): string {
    return this.repoPath;
  }

  // Search commit log with grep pattern
  async logGrep(pattern: string, limit: number = 20): Promise<CommitInfo[]> {
    const { stdout } = await this.git([
      'log', `-${limit}`, '--oneline', '--all',
      '--format=%H|%s|%ai|%D',
      `--grep=${pattern}`,
      '-i',
    ]);
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, ...rest] = line.split('|');
      const fullRest = rest.join('|');
      const match = fullRest.match(/^(\d{4}-\d{2}-\d{2}.+?)\|?(.*)$/);
      if (match) {
        const branchRef = match[2].trim();
        const branch = branchRef ? branchRef.split(',').map(s => s.trim().replace(/^(HEAD -> |tag: )/, '')).find(s => s.length > 0) : undefined;
        return { hash, message, date: match[1], branch };
      }
      return { hash, message, date: fullRest };
    });
  }

  // Get changed file names via diff
  async diffNames(ref?: string): Promise<string[]> {
    const args = ['diff', '--name-only'];
    if (ref) args.push(ref);
    else args.push('HEAD~1');
    try {
      const { stdout } = await this.git(args);
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  // Get diff stat
  async diffStat(ref?: string): Promise<string> {
    const args = ['diff', '--stat'];
    if (ref) args.push(ref);
    else args.push('HEAD~1');
    try {
      const { stdout } = await this.git(args);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  // Get commit log for a specific file
  async logFile(file: string, limit: number = 10): Promise<CommitInfo[]> {
    const { stdout } = await this.git([
      'log', `-${limit}`, '--oneline',
      '--format=%H|%s|%ai',
      '--', file,
    ]);
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, ...dateParts] = line.split('|');
      return { hash, message, date: dateParts.join('|') };
    });
  }

  // Revert a commit
  async revertCommit(hash: string): Promise<string> {
    const { stdout } = await this.git(['revert', '--no-edit', hash]);
    return stdout.trim();
  }

  // Stash current changes
  async stash(): Promise<void> {
    await this.git(['stash', 'push', '-m', 'agent-auto-stash']);
  }

  // Pop the most recent stash
  async stashPop(): Promise<void> {
    await this.git(['stash', 'pop']);
  }

  // Run a safe git operation (no throw on expected errors)
  private async gitSafe(args: string[]): Promise<{ stdout: string; stderr: string } | null> {
    try {
      return await execFileAsync('git', args, { cwd: this.repoPath, maxBuffer: 10 * 1024 * 1024 });
    } catch {
      return null;
    }
  }

  // Search commits with multiple keywords (OR logic), returns expanded context entries
  async searchContext(
    keywords: string[],
    currentBranch: string,
    limit: number = 15,
  ): Promise<GitContextEntry[]> {
    if (keywords.length === 0) return [];
    const pattern = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\|');
    const commits = await this.logGrep(pattern, limit);
    if (commits.length === 0) return [];

    const entries: GitContextEntry[] = [];
    for (const c of commits) {
      let files: string[] = [];
      try {
        files = await this.diffNames(c.hash);
      } catch {
        // skip file lookup on error
      }
      entries.push({
        hash: c.hash.slice(0, 8),
        message: c.message,
        date: c.date,
        branch: c.branch ?? 'unknown',
        files,
      });
    }

    // Cross-branch weighting: current branch results first
    entries.sort((a, b) => {
      const aCur = a.branch === currentBranch ? 0 : 1;
      const bCur = b.branch === currentBranch ? 0 : 1;
      return aCur - bCur;
    });

    return entries;
  }
}