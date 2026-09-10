/**
 * 招牌机制行为测试（P1-A）：逐回合 git 回滚 TurnRecorder。
 *
 * 覆盖：回滚锚点（pre-turn commit / 干净树 HEAD）、写前置状态捕获（modified/created/去重）、
 * git diff 补充检测、lastTurnAgentPaths 精确提交（避免把用户手动改动卷入自动提交）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TurnRecorder } from './turn-recorder.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { TurnStore } from './turn-store.js';

let tmpDir: string;
let projectDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-recorder-'));
  projectDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(projectDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGit(overrides: Partial<Record<'isRepo' | 'hasUncommittedChanges' | 'commit' | 'git', unknown>> = {}) {
  const gitManager = {
    isRepo: vi.fn().mockResolvedValue(true),
    hasUncommittedChanges: vi.fn().mockResolvedValue(false),
    commit: vi.fn().mockResolvedValue('anchor-abc'),
    git: vi.fn().mockResolvedValue({ stdout: 'head-1234\n', stderr: '' }),
    ...overrides,
  } as unknown as GitManager;
  return gitManager;
}

function makeTurnStore() {
  return { save: vi.fn().mockResolvedValue(undefined) } as unknown as TurnStore;
}

describe('TurnRecorder（逐回合 git 回滚）', () => {
  it('干净工作树：回滚锚点 = 当前 HEAD，不产生 pre-turn commit', async () => {
    const git = makeGit();
    const rec = new TurnRecorder(git, makeTurnStore(), projectDir);
    const preCommit = await rec.startTurn(1);

    expect(preCommit).toBe('head-1234');
    expect(git.commit).not.toHaveBeenCalled();
  });

  it('脏工作树：回滚锚点 = pre-turn commit，且只提交上一回合 agent 触碰的文件', async () => {
    const git = makeGit({ hasUncommittedChanges: vi.fn().mockResolvedValue(true) });
    const rec = new TurnRecorder(git, makeTurnStore(), projectDir);

    // 第 1 回合：无 lastTurnAgentPaths → commit 不指定 paths
    await rec.startTurn(1);
    expect(git.commit).toHaveBeenCalledWith('auto: pre-turn-1', undefined);

    // 记录一个文件并结束回合 → lastTurnAgentPaths 被捕获
    const f = path.join(projectDir, 'a.ts');
    fs.writeFileSync(f, 'x');
    rec.recordPreState(f);
    await rec.endTurn();

    // 第 2 回合：commit 只收编上一回合触碰的文件，不卷入用户手动改动
    await rec.startTurn(2);
    expect(git.commit).toHaveBeenLastCalledWith('auto: pre-turn-2', ['a.ts']);
  });

  it('recordPreState：created（文件不存在）记录无 oldContent；modified 记录 oldContent；同路径去重', async () => {
    const rec = new TurnRecorder(makeGit(), makeTurnStore(), projectDir);
    await rec.startTurn(1);

    const newFile = path.join(projectDir, 'new.ts');
    const existFile = path.join(projectDir, 'exist.ts');
    fs.writeFileSync(existFile, 'OLD-CONTENT');

    rec.recordPreState(newFile);
    rec.recordPreState(existFile);
    rec.recordPreState(existFile); // 去重：不重复记录

    const changedFiles = ((rec as unknown as { currentRecord: { changedFiles: unknown[] } }).currentRecord?.changedFiles) as Array<{
      path: string;
      action: string;
      oldContent?: string;
    }>;

    expect(changedFiles).toHaveLength(2);
    const created = changedFiles.find((c) => c.path === 'new.ts');
    const modified = changedFiles.find((c) => c.path === 'exist.ts');
    expect(created?.action).toBe('created');
    expect(created?.oldContent).toBeUndefined();
    expect(modified?.action).toBe('modified');
    expect(modified?.oldContent).toBe('OLD-CONTENT');
  });

  it('recordCommand：bash 命令被收集进回合记录', async () => {
    const turnStore = makeTurnStore();
    const rec = new TurnRecorder(makeGit(), turnStore, projectDir);
    await rec.startTurn(1);
    rec.recordCommand('npm test');
    rec.recordCommand('git status');

    const record = await rec.endTurn();
    expect(record?.commands).toEqual(['npm test', 'git status']);
  });

  it('endTurn：git diff 补充检测遗漏文件（bash rm 等未被拦截的操作）', async () => {
    const git = makeGit({
      git: vi.fn().mockResolvedValue({ stdout: 'M\tmissed.ts\nA\tnewfile.ts\n', stderr: '' }),
    });
    const turnStore = makeTurnStore();
    const rec = new TurnRecorder(git, turnStore, projectDir);
    await rec.startTurn(1);

    const record = await rec.endTurn();

    const paths = record?.changedFiles.map((c) => c.path);
    expect(paths).toContain('missed.ts');
    expect(paths).toContain('newfile.ts');
    expect(record?.changedFiles.find((c) => c.path === 'missed.ts')?.action).toBe('modified');
    expect(record?.changedFiles.find((c) => c.path === 'newfile.ts')?.action).toBe('created');
    expect(turnStore.save).toHaveBeenCalledWith(record);
  });

  it('endTurn 后状态复位：currentRecord 清空，recordedPaths 清空', async () => {
    const rec = new TurnRecorder(makeGit(), makeTurnStore(), projectDir);
    await rec.startTurn(1);
    rec.recordPreState(path.join(projectDir, 'x.ts'));
    await rec.endTurn();

    expect((rec as unknown as { currentRecord: unknown }).currentRecord).toBeNull();
    expect((rec as unknown as { recordedPaths: Set<string> }).recordedPaths.size).toBe(0);
  });
});
