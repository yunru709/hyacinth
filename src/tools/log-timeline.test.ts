/**
 * log-timeline.test.ts — 回归点
 *
 * fixture 用的是**实机采样的真实形态**，不是想象出来的：
 *   - tui.log 风格：{"ts","lvl","msg","ctx"}
 *   - events.jsonl 风格：{"type","timestamp"}
 *   - 而且**混有非 JSON 行**（真实日志里确实如此）
 * 重点覆盖：字段自动探测、json/plain 混排计数、无时间戳行的统计、
 * 模板聚合、空档（gaps）检测、last 模式、filter。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogTimelineTool } from './log-timeline.js';

function tmpLog(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtl-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const MIXED = [
  '{"ts":"2026-09-18T10:00:00.000Z","lvl":"info","msg":"start","ctx":{}}',
  '{"ts":"2026-09-18T10:00:01.000Z","lvl":"info","msg":"tick"}',
  '{"ts":"2026-09-18T10:00:02.000Z","lvl":"error","msg":"oops 42"}',
  'plain line with no timestamp',
  '2026-09-18T10:10:00.000Z plain with timestamp',
  '{"ts":"2026-09-18T10:20:00.000Z","lvl":"info","msg":"tick"}',
  '',
].join('\n');

const tool = new LogTimelineTool();

describe('log_timeline', () => {
  it('自动探测字段（time=ts / event=msg / level=lvl）并区分 json 与 plain 行', async () => {
    const p = tmpLog('tui.log', MIXED);
    const r = await tool.execute({ path: p });
    expect(r).toContain('time=ts');
    expect(r).toContain('event=msg');
    expect(r).toContain('level=lvl');
    expect(r).toContain('json 4 / plain 2');
    // 没有可用时间戳的行数（那条纯文本没有时间戳）
    expect(r).toContain('no usable timestamp 1');
  });

  it('按 level 计数', async () => {
    const p = tmpLog('a.log', MIXED);
    const r = await tool.execute({ path: p });
    expect(r).toContain('by level:');
    expect(r).toMatch(/3\s+info/);
    expect(r).toMatch(/1\s+error/);
  });

  it('事件 Top N：出现次数与首次出现时间', async () => {
    const p = tmpLog('b.log', MIXED);
    const r = await tool.execute({ path: p });
    expect(r).toMatch(/2\s+tick\s+first 2026-09-18T10:00:01Z/);
    expect(r).toContain('start');
  });

  it('时间范围与直方图', async () => {
    const p = tmpLog('c.log', MIXED);
    const r = await tool.execute({ path: p });
    expect(r).toContain('range: 2026-09-18T10:00:00Z → 2026-09-18T10:20:00Z');
    expect(r).toContain('timeline (bucket');
    expect(r).toContain('█');
  });

  it('检测时间空档（两段 ~10 分钟）', async () => {
    const p = tmpLog('d.log', MIXED);
    const r = await tool.execute({ path: p });
    expect(r).toContain('gaps ≥');
    // 10:00:02 → 10:10:00 与 10:10:00 → 10:20:00
    expect(r).toContain('2026-09-18T10:00:02Z → 2026-09-18T10:10:00Z');
    expect(r).toContain('2026-09-18T10:10:00Z → 2026-09-18T10:20:00Z');
  });

  it('events.jsonl 风格（type + timestamp）也能自动探测', async () => {
    const p = tmpLog('events.jsonl', [
      '{"type":"session_start","session_id":"s1","timestamp":"2026-09-18T10:40:43.130Z"}',
      '{"type":"thinking","content":"","timestamp":"2026-09-18T10:40:44.130Z"}',
      '{"type":"thinking","content":"","timestamp":"2026-09-18T10:40:45.130Z"}',
      '',
    ].join('\n'));
    const r = await tool.execute({ path: p });
    expect(r).toContain('time=timestamp');
    expect(r).toContain('event=type');
    expect(r).toMatch(/2\s+thinking/);
  });

  it('纯文本行按模板聚合（数字被折叠）', async () => {
    const p = tmpLog('plain.log', [
      '2026-09-18T10:00:00Z user 17 logged in',
      '2026-09-18T10:00:01Z user 42 logged in',
      '2026-09-18T10:00:02Z user 99 logged in',
      '',
    ].join('\n'));
    const r = await tool.execute({ path: p });
    expect(r).toContain('user <n> logged in');
    expect(r).toMatch(/3\s+user <n> logged in/);
  });

  it('last 模式：只算窗口内的部分，并说明直方图被跳过', async () => {
    const p = tmpLog('e.log', MIXED);
    const r = await tool.execute({ path: p, last: '5m' });
    expect(r).toContain('[filtered to last 5m]');
    expect(r).toContain('skipped in "last" mode');
  });

  it('filter 子串只保留匹配行', async () => {
    const p = tmpLog('f.log', MIXED);
    const r = await tool.execute({ path: p, filter: 'tick' });
    expect(r).toContain('filtered out');
    expect(r).toMatch(/2\s+tick/);
    expect(r).not.toContain('oops 42');
  });

  it('samples>0 时附带样例行', async () => {
    const p = tmpLog('g.log', MIXED);
    const r = await tool.execute({ path: p, samples: 1, top: 3 });
    expect(r).toContain('"msg":"tick"');
  });

  it('文件不存在时返回错误而不是抛错', async () => {
    const r = await tool.execute({ path: 'C:\\__nope__\\x.log' });
    expect(r).toContain('no log files found');
  });

  it('目录模式：递归收集日志文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtl-dir-'));
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.log'), '{"ts":"2026-09-18T10:00:00Z","msg":"one"}\n');
    fs.writeFileSync(path.join(dir, 'sub', 'b.jsonl'), '{"ts":"2026-09-18T10:00:01Z","msg":"two"}\n');
    fs.writeFileSync(path.join(dir, 'ignore.md'), 'not a log\n');
    const r = await tool.execute({ path: dir });
    expect(r).toContain('files: 2');
    expect(r).toMatch(/1\s+one/);
    expect(r).toMatch(/1\s+two/);
  });
});
