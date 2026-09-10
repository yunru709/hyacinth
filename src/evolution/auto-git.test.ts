/**
 * AutoGit 单测（Supervisor 方案 S4）—— 真实临时 git 仓走全策略。
 *
 * 三分支矩阵：配置关/开 × 工作区脏/净 × 启动处置 ignore/commit/stash，
 * 外加 createBackup 的 bundle+tag 双保险与非 git 仓抛错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { GitManager } from './git-manager.js';
import { AutoGit, createBackup, type AutoGitConfigSource } from './auto-git.js';

async function initRepo(): Promise<{ root: string; git: GitManager; conf: Record<string, unknown> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'auto-git-test-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run(['init']);
  run(['config', 'user.email', 'test@hyacinth.local']);
  run(['config', 'user.name', 'hyacinth-test']);
  await writeFile(path.join(root, 'seed.txt'), 'seed\n', 'utf-8');
  run(['add', '.']);
  run(['commit', '-m', 'init', '--no-gpg-sign']);
  return { root, git: new GitManager(root), conf: {} };
}

function confSource(conf: Record<string, unknown>): AutoGitConfigSource {
  return { get: <T>(p: string) => conf[p] as T };
}

/** 当前分支 HEAD 提交信息（单提交断言用） */
function lastCommitMessage(root: string): string {
  return execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, stdio: 'pipe' })
    .toString().trim();
}

/** 自 init 提交之后的提交数 */
function commitCount(root: string): number {
  const out = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, stdio: 'pipe' })
    .toString().trim();
  return parseInt(out, 10);
}

describe('AutoGit', () => {
  let root: string;
  let git: GitManager;
  let conf: Record<string, unknown>;

  beforeEach(async () => {
    ({ root, git, conf } = await initRepo());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('onTurnEnd：配置关（默认）→ 不提交', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x\n', 'utf-8');
    const auto = new AutoGit({ gitManager: git, configCenter: confSource(conf) });
    await auto.onTurnEnd(7);
    expect(commitCount(root)).toBe(1);
  });

  it('onTurnEnd：配置开 + 脏 → 提交 auto: post-turn-N', async () => {
    conf['autoGit.postTurnCommit'] = true;
    await writeFile(path.join(root, 'a.txt'), 'x\n', 'utf-8');
    const auto = new AutoGit({ gitManager: git, configCenter: confSource(conf) });
    await auto.onTurnEnd(7);
    expect(commitCount(root)).toBe(2);
    expect(lastCommitMessage(root)).toBe('auto: post-turn-7');
  });

  it('onTurnEnd：配置开 + 净 → 不产生提交', async () => {
    conf['autoGit.postTurnCommit'] = true;
    const auto = new AutoGit({ gitManager: git, configCenter: confSource(conf) });
    await auto.onTurnEnd(1);
    expect(commitCount(root)).toBe(1);
  });

  it('startupDispose：commit → 提交 boot 锚点', async () => {
    conf['autoGit.startupAction'] = 'commit';
    await writeFile(path.join(root, 'dirty.txt'), 'left over\n', 'utf-8');
    const auto = new AutoGit({ gitManager: git, configCenter: confSource(conf) });
    await auto.startupDispose();
    expect(commitCount(root)).toBe(2);
    expect(lastCommitMessage(root)).toMatch(/^auto: boot-anchor-/);
  });

  it('startupDispose：stash → 工作区变净', async () => {
    conf['autoGit.startupAction'] = 'stash';
    await writeFile(path.join(root, 'dirty.txt'), 'left over\n', 'utf-8');
    const auto = new AutoGit({ gitManager: git, configCenter: confSource(conf) });
    await auto.startupDispose();
    expect(await git.hasUncommittedChanges()).toBe(false);
  });

  it('startupDispose：ignore（默认）→ 工作区保持脏', async () => {
    await writeFile(path.join(root, 'dirty.txt'), 'left over\n', 'utf-8');
    const auto = new AutoGit({ gitManager: git, configCenter: confSource(conf) });
    await auto.startupDispose();
    expect(await git.hasUncommittedChanges()).toBe(true);
  });
});

describe('createBackup', () => {
  let root: string;
  let git: GitManager;

  beforeEach(async () => {
    ({ root, git } = await initRepo());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('bundle 落盘 + tag 打上（双保险）', async () => {
    const { bundlePath, tag } = await createBackup(git, root, 'pre-refactor');

    expect(existsSync(bundlePath)).toBe(true);
    expect(path.basename(bundlePath)).toMatch(/^pre-refactor-.*\.bundle$/);
    expect(path.dirname(bundlePath)).toContain(path.join('.agent', 'backups'));

    const tags = execFileSync('git', ['tag', '-l', tag], { cwd: root, stdio: 'pipe' }).toString().trim();
    expect(tags).toBe(tag);
  });

  it('rev-parse 失败（不在 git 仓内）→ 抛错并提示', async () => {
    const failingGit = {
      git: async () => { throw new Error('fatal: not a git repository'); },
    } as unknown as GitManager;
    await expect(createBackup(failingGit, root, 'x')).rejects.toThrow(/git 仓库/);
  });

  it('bundle 目录在 .agent/backups 下且含 bundle 文件', async () => {
    await createBackup(git, root, 't1');
    const dir = path.join(root, '.agent', 'backups');
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.bundle$/);
  });
});
