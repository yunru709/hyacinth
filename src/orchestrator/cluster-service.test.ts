/**
 * cluster-service 测试 —— 闭包触手正规化（方案 C）状态迁移语义。
 *
 * 覆盖：
 * - DeepCompressState / needsCompression 的写入-读取往返
 * - restoreSummary 幂等（restore=false 时 no-op）
 * - restoreSummary 恢复后状态自动复位（original 非 null → 回写；null → 删除临时文件）
 * - buildClusterHistoryTransform 委托 + makeDeps 惰性构造（每轮取当前值）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClusterService, type ClusterService } from './cluster-service.js';
import type { ClusterDeps } from './loop-cluster.js';

/** 最小 deps：测试路径下不会触达存储/压缩器（stat 失败即返回 null） */
function makeDummyDeps(sessionDir: string): ClusterDeps {
  return {
    sessionDir,
    compressor: null as never, // 5MB 阈值检查不通过，不会走到
    conversationStore: { readFull: async () => [] } as never,
    eventStore: { readAll: async () => [] } as never,
    summaryStore: {} as never,
    maxContextTokens: 100_000,
    getCurrentIntentCapability: () => 'dev',
  };
}

function makeService(sessionDir = path.join(os.tmpdir(), 'hyacinth-cluster-svc-test-nonexistent')): {
  svc: ClusterService;
  makeDeps: ReturnType<typeof vi.fn>;
} {
  const makeDeps = vi.fn(() => makeDummyDeps(sessionDir));
  return { svc: createClusterService(makeDeps), makeDeps };
}

describe('cluster-service deep 压缩状态迁移', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初始状态：无 deep 状态、无需强制重压缩', () => {
    const { svc } = makeService();
    expect(svc.getDeepCompressState()).toEqual({ original: null, restore: false });
    expect(svc.getNeedsCompression()).toBe(false);
  });

  it('setDeepCompressState → getDeepCompressState 往返', () => {
    const { svc } = makeService();
    svc.setDeepCompressState({ original: '旧的模板', restore: true });
    expect(svc.getDeepCompressState()).toEqual({ original: '旧的模板', restore: true });
    // 覆盖写：restore 复位
    svc.setDeepCompressState({ original: null, restore: false });
    expect(svc.getDeepCompressState()).toEqual({ original: null, restore: false });
  });

  it('setNeedsCompression / getNeedsCompression 往返', () => {
    const { svc } = makeService();
    svc.setNeedsCompression(true);
    expect(svc.getNeedsCompression()).toBe(true);
    svc.setNeedsCompression(false);
    expect(svc.getNeedsCompression()).toBe(false);
  });

  it('restoreSummary 幂等：restore=false 时 no-op（不碰文件、状态保持）', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    const { svc } = makeService();

    svc.setDeepCompressState({ original: '保留', restore: false });
    svc.restoreSummary();

    expect(writeSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(svc.getDeepCompressState()).toEqual({ original: '保留', restore: false });
  });

  it('restoreSummary：original 非 null → 回写原模板并复位状态', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const { svc } = makeService();

    svc.setDeepCompressState({ original: '原始模板内容', restore: true });
    svc.restoreSummary();

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.join('.agent', 'prompts', 'summary.md')),
      '原始模板内容',
      'utf-8',
    );
    expect(svc.getDeepCompressState()).toEqual({ original: null, restore: false });
  });

  it('restoreSummary：original=null → 删除临时文件并复位状态', () => {
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    const { svc } = makeService();

    svc.setDeepCompressState({ original: null, restore: true });
    svc.restoreSummary();

    expect(unlinkSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.join('.agent', 'prompts', 'summary.md')),
    );
    expect(svc.getDeepCompressState()).toEqual({ original: null, restore: false });
  });

  it('restoreSummary 连续调用：首次消费即复位，第二次 no-op', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const { svc } = makeService();

    svc.setDeepCompressState({ original: 'x', restore: true });
    svc.restoreSummary();
    svc.restoreSummary();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(svc.getDeepCompressState()).toEqual({ original: null, restore: false });
  });
});

describe('cluster-service 意图簇委托', () => {
  it('buildClusterHistoryTransform 委托 loop-cluster，stat 失败（无全量归档）→ null', async () => {
    const { svc } = makeService();
    await expect(svc.buildClusterHistoryTransform()).resolves.toBeNull();
  });

  it('makeDeps 惰性构造：每次调用现取（与旧闭包逐位等价）', async () => {
    const { svc, makeDeps } = makeService();
    await svc.buildClusterHistoryTransform();
    await svc.buildClusterHistoryTransform();
    expect(makeDeps).toHaveBeenCalledTimes(2);
  });
});
