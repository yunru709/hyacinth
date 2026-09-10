/**
 * SayHistoryStore 测试 —— 陪伴台词历史（companion.sayHistory 数据源）。
 * 覆盖：append / listByCharacter（倒序）/ 按角色隔离 / sayId 幂等 /
 * 每角色上限裁剪 / clearByCharacter。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SayHistoryStore, DEFAULT_SAY_HISTORY_KEEP } from './say-history.js';

describe('SayHistoryStore（companion.sayHistory 数据源）', () => {
  let tmp: string;
  let store: SayHistoryStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'say-history-test-'));
    store = new SayHistoryStore(tmp);
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
  });

  it('append + listByCharacter：时间倒序返回', () => {
    store.append({ sayId: 's1', character: 'alice', mode: 'speak', text: '你好', at: '2026-08-31T10:00:00Z' });
    store.append({ sayId: 's2', character: 'alice', mode: 'speak', text: '今天天气不错', think: '她心情好', at: '2026-08-31T10:01:00Z' });

    const rows = store.listByCharacter('alice');
    expect(rows).toHaveLength(2);
    expect(rows[0].sayId).toBe('s2'); // 最新在前
    expect(rows[0].think).toBe('她心情好');
  });

  it('按角色隔离：不同角色互不串扰', () => {
    store.append({ sayId: 's1', character: 'alice', mode: 'speak', text: 'alice 的话', at: '2026-08-31T10:00:00Z' });
    store.append({ sayId: 's2', character: 'bob', mode: 'speak', text: 'bob 的话', at: '2026-08-31T10:01:00Z' });

    const alice = store.listByCharacter('alice');
    const bob = store.listByCharacter('bob');
    expect(alice).toHaveLength(1);
    expect(alice[0].text).toBe('alice 的话');
    expect(bob[0].text).toBe('bob 的话');
  });

  it('sayId 幂等：同 sayId 重复 append 只保留一条（防工具路径与兜底路径双写）', () => {
    const entry = { sayId: 's1', character: 'alice', mode: 'speak' as const, text: '你好', at: '2026-08-31T10:00:00Z' };
    store.append(entry);
    store.append(entry); // 重复

    expect(store.listByCharacter('alice')).toHaveLength(1);
  });

  it('上限裁剪：每角色只保留最近 keep 条', () => {
    const keep = 3;
    const small = new SayHistoryStore(tmp, keep);
    for (let i = 1; i <= 5; i++) {
      small.append({ sayId: `s${i}`, character: 'alice', mode: 'speak', text: `第${i}句`, at: `2026-08-31T10:0${i}:00Z` });
    }

    const rows = small.listByCharacter('alice');
    expect(rows).toHaveLength(keep);
    expect(rows[0].sayId).toBe('s5'); // 保留最近 3 条：s3/s4/s5
    expect(rows[2].sayId).toBe('s3');
  });

  it('clearByCharacter：删除角色全部台词', () => {
    store.append({ sayId: 's1', character: 'alice', mode: 'speak', text: '你好', at: '2026-08-31T10:00:00Z' });
    store.clearByCharacter('alice');
    expect(store.listByCharacter('alice')).toHaveLength(0);
  });

  it('缺省 keep 常量存在（写入时裁剪依据）', () => {
    expect(DEFAULT_SAY_HISTORY_KEEP).toBeGreaterThanOrEqual(200);
  });
});
