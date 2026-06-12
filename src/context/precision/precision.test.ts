/**
 * 精确模式单元测试
 * 只测纯逻辑部分（关键词池、历史过滤），不依赖 LLM。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeywordPool } from './keyword-pool.js';
import { PreciseStrategy } from './strategy.js';
import { DefaultStrategy } from './default.js';
import type { Message } from '../../types.js';
import fs from 'node:fs';
import path from 'node:path';

// ── 测试辅助 ──────────────────────────────────────────────────────────

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: { type: 'text', text } };
}

function makeSessionDir(): string {
  const dir = path.join(process.cwd(), '.agent', 'test-precision', `test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── KeywordPool ───────────────────────────────────────────────────────

describe('KeywordPool', () => {
  let pool: KeywordPool;
  let dir: string;

  beforeEach(() => {
    dir = makeSessionDir();
    pool = new KeywordPool(dir);
  });

  it('应该从空开始', () => {
    expect(pool.size()).toBe(0);
    expect(pool.getAll()).toEqual([]);
  });

  it('应该去重并累加权重', () => {
    pool.add('线程', 1);
    pool.add('线程', 2);
    pool.add('并发', 1);
    expect(pool.size()).toBe(2);
    // 权重：线程=3，并发=1 → 排序：线程先
    expect(pool.getTop(2)).toEqual(['线程', '并发']);
  });

  it('addAll 应批量添加', () => {
    pool.addAll([
      { keyword: 'API', weight: 2, source: 'user' },
      { keyword: '线程', weight: 1, source: 'user' },
      { keyword: 'API', weight: 1, source: 'assistant' },
    ]);
    expect(pool.size()).toBe(2);
    expect(pool.getTop(1)).toEqual(['API']); // API weight=3 > 线程 weight=1
  });

  it('prune 应移除权重最低的', () => {
    pool.add('a', 5);
    pool.add('b', 3);
    pool.add('c', 1);
    pool.add('d', 1);
    pool.prune(2);
    expect(pool.size()).toBe(2);
    expect(pool.getAll()).toEqual(['a', 'b']);
  });

  it('应持久化并重新加载', () => {
    pool.add('会话', 2);
    pool.add('上下文', 1);
    pool.save();

    const pool2 = new KeywordPool(dir);
    expect(pool2.size()).toBe(2);
    expect(pool2.getTop(2)).toEqual(['会话', '上下文']);
  });

  it('空池 getTop 应返回空数组', () => {
    expect(pool.getTop(10)).toEqual([]);
  });
});

// ── PreciseStrategy.filterHistory ─────────────────────────────────────

describe('PreciseStrategy.filterHistory', () => {
  let strategy: PreciseStrategy;
  let dir: string;

  beforeEach(() => {
    dir = makeSessionDir();
    strategy = new PreciseStrategy(dir, { keywordMatchThreshold: 1, recentCount: 2 });
  });

  it('无关键词时应返回最近 N×2 条消息', () => {
    const history: Message[] = [
      msg('user', '你好'),           // 0
      msg('assistant', '你好！'),    // 1
      msg('user', '天气怎么样'),     // 2
      msg('assistant', '晴天'),      // 3
      msg('user', '写代码'),         // 4
      msg('assistant', '好的'),      // 5 — recent
    ];
    const filtered = strategy.filterHistory(history);
    // recentCount=2 → 保留最近 4 条
    expect(filtered.length).toBe(4);
    expect(filtered[0]!.content).toEqual(msg('user', '天气怎么样').content);
  });

  it('有关键词时应保留匹配的历史 + 最近 N×2', () => {
    strategy['pool'].add('编程', 5);
    strategy['pool'].add('函数', 3);

    const history: Message[] = [
      msg('user', '编程怎么入门'),        // 0 — 匹配"编程"
      msg('assistant', '从基础开始'),     // 1
      msg('user', '函数怎么写'),          // 2 — 匹配"函数"
      msg('assistant', 'function xxx'),   // 3
      msg('user', '吃饭了没'),            // 4 — 无关 ← recent 起始
      msg('assistant', '吃了'),           // 5
      msg('user', '现在的任务是'),         // 6
      msg('assistant', '测试精确模式'),   // 7
    ];
    const filtered = strategy.filterHistory(history);
    // older(0-3)中0和2匹配关键词 → 保留 matched + recent(4-7)
    // 预期: matched(0-3中匹配的部分) + recent(4条) ≥ 5
    expect(filtered.length).toBeGreaterThanOrEqual(5);
    const texts = filtered.map(m => (m.content as { text: string }).text);
    expect(texts).toContain('编程怎么入门');
    expect(texts).toContain('函数怎么写');
    // 最近的消息应保留
    expect(texts).toContain('测试精确模式');
  });

  it('prepareCompose 应返回 preciseMode: true', () => {
    const opts = strategy.prepareCompose('/tmp/persona');
    expect(opts.preciseMode).toBe(true);
    expect(opts.personaDir).toBeUndefined();
  });
});

// ── DefaultStrategy ───────────────────────────────────────────────────

describe('DefaultStrategy', () => {
  const strategy = new DefaultStrategy();

  it('filterHistory 应原样返回', () => {
    const history: Message[] = [msg('user', 'a'), msg('assistant', 'b')];
    expect(strategy.filterHistory(history)).toEqual(history);
  });

  it('prepareCompose 应透传 personaDir', () => {
    const opts = strategy.prepareCompose('/tmp/persona');
    expect(opts.personaDir).toBe('/tmp/persona');
    expect(opts.preciseMode).toBe(false);
  });

  it('analyzeTurn 应不抛错', async () => {
    await expect(strategy.analyzeTurn([], {} as any)).resolves.toBeUndefined();
  });
});
