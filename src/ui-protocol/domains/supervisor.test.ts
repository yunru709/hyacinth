/**
 * supervisor 域测试（Supervisor 方案 S5）。
 * 覆盖：全数据 getter / 可选 getter 缺省 null / getter 异常降级 null /
 * 异步 getter 支持 / lastRestart 存档读取。
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';

import { createSupervisorDomain, type SupervisorStatus } from './supervisor.js';

describe('supervisor domain (S5)', () => {
  // 隔离 HOME，避免读到真实 ~/.agent/.restart-reason
  let savedHome: string | undefined;
  let tempHome: string;

  async function isolateHome(): Promise<void> {
    savedHome = process.env.USERPROFILE ?? process.env.HOME;
    tempHome = await mkdtemp(path.join(tmpdir(), 'sup-domain-'));
    process.env.USERPROFILE = tempHome;
    process.env.HOME = tempHome;
  }

  function restoreHome(): void {
    if (savedHome !== undefined) {
      process.env.USERPROFILE = savedHome;
      process.env.HOME = savedHome;
    }
    void rm(tempHome, { recursive: true, force: true }).catch(() => {});
  }

  it('全数据：uptime/pid/guardian/plugins/watchers/git 齐备', async () => {
    await isolateHome();
    try {
      const domain = createSupervisorDomain({
        getPluginHosts: () => [{ id: 'p1', state: 'mounted', deps: [] }],
        getWatcherStatus: () => ({ started: true, watcherCount: 13, debounceMs: 500 }),
        getGitSummary: async () => ({ isRepo: true, dirty: true, lastAutoCommit: 'auto: pre-turn-1' }),
      });
      const status = await (domain.status as (p: unknown, c: unknown) => Promise<SupervisorStatus>)({}, {});

      expect(status.uptimeSec).toBeGreaterThanOrEqual(0);
      expect(status.pid).toBe(process.pid);
      expect(status.guardian).toBe(false); // 测试进程无 GUARDIAN_ENV
      expect(status.plugins).toEqual([{ id: 'p1', state: 'mounted', deps: [] }]);
      expect(status.watchers).toEqual({ started: true, watcherCount: 13, debounceMs: 500 });
      expect(status.git).toEqual({ isRepo: true, dirty: true, lastAutoCommit: 'auto: pre-turn-1' });
    } finally {
      restoreHome();
    }
  });

  it('可选 getter 未注入 → watchers/git 为 null', async () => {
    await isolateHome();
    try {
      const domain = createSupervisorDomain({ getPluginHosts: () => [] });
      const status = await (domain.status as (p: unknown, c: unknown) => Promise<SupervisorStatus>)({}, {});
      expect(status.watchers).toBeNull();
      expect(status.git).toBeNull();
      expect(status.lastRestart).toBeNull(); // 无存档
    } finally {
      restoreHome();
    }
  });

  it('getter 抛异常 → 降级 null（可观测面绝不抛错）', async () => {
    await isolateHome();
    try {
      const domain = createSupervisorDomain({
        getPluginHosts: () => [],
        getWatcherStatus: () => { throw new Error('boom'); },
        getGitSummary: () => { throw new Error('boom'); },
      });
      const status = await (domain.status as (p: unknown, c: unknown) => Promise<SupervisorStatus>)({}, {});
      expect(status.watchers).toBeNull();
      expect(status.git).toBeNull();
    } finally {
      restoreHome();
    }
  });

  it('lastRestart：读取 .restart-reason 存档', async () => {
    await isolateHome();
    try {
      const agentDir = path.join(os.homedir(), '.agent');
      await mkdir(agentDir, { recursive: true });
      writeFileSync(
        path.join(agentDir, '.restart-reason'),
        JSON.stringify({ code: 44, source: 'plugin-hot-reload', detail: 'p1: boom' }),
        'utf-8',
      );
      const domain = createSupervisorDomain({ getPluginHosts: () => [] });
      const status = await (domain.status as (p: unknown, c: unknown) => Promise<SupervisorStatus>)({}, {});
      expect(status.lastRestart).toEqual({ code: 44, source: 'plugin-hot-reload', detail: 'p1: boom' });
    } finally {
      restoreHome();
    }
  });
});
