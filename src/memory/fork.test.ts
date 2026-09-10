/**
 * 会话分支（A7）单测：materializeFork。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeFork } from './fork.js';

let tmpDir: string;
let sourceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-'));
  sourceDir = path.join(tmpDir, 'source');
  fs.mkdirSync(sourceDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function msg(role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role, content: { type: 'text', text }, ...extra };
}

async function writeArchive(msgs: Record<string, unknown>[]): Promise<void> {
  const content = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
  await fsPromises.writeFile(path.join(sourceDir, 'conversation_full.jsonl'), content, 'utf-8');
}

describe('materializeFork（会话分支投影）', () => {
  it('从存档取前 N 条并剥离 _compressed/_cluster_id 标记', async () => {
    await writeArchive([
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c', { _compressed: { intent: 'coding', summary_hash: 'h', compressed_at: 't' }, _cluster_id: 'c1' }),
      msg('assistant', 'd', { _compressed: { intent: 'general', summary_hash: 'h2', compressed_at: 't2' } }),
    ]);
    const target = path.join(tmpDir, 'target');
    const result = await materializeFork(sourceDir, 3, target);

    expect(result.messageCount).toBe(3);
    expect(result.sourceCount).toBe(4);
    expect(result.droppedMarkers).toBe(2); // 第 3 条带 _compressed + _cluster_id

    // 目标会话两个文件内容一致，且标记已剥离
    const conv = await fsPromises.readFile(path.join(target, 'conversation.jsonl'), 'utf-8');
    const full = await fsPromises.readFile(path.join(target, 'conversation_full.jsonl'), 'utf-8');
    expect(conv).toBe(full);
    const parsed = conv.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(3);
    expect(parsed[2]).not.toHaveProperty('_compressed');
    expect(parsed[2]).not.toHaveProperty('_cluster_id');
    expect(parsed[2].content).toEqual({ type: 'text', text: 'c' });
    // 事件/统计占位文件已建
    expect(fs.existsSync(path.join(target, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'stats.json'))).toBe(true);
  });

  it('无存档（从未压缩）时回退读 conversation.jsonl', async () => {
    await fsPromises.writeFile(
      path.join(sourceDir, 'conversation.jsonl'),
      JSON.stringify(msg('user', 'x')) + '\n' + JSON.stringify(msg('assistant', 'y')) + '\n',
      'utf-8',
    );
    const target = path.join(tmpDir, 'target2');
    const result = await materializeFork(sourceDir, 1, target);
    expect(result.sourceCount).toBe(2);
    expect(result.messageCount).toBe(1);
  });

  it('keep_messages 越界 / 非法 → 抛错', async () => {
    await writeArchive([msg('user', 'a'), msg('assistant', 'b')]);
    const target = path.join(tmpDir, 'target3');
    await expect(materializeFork(sourceDir, 3, target)).rejects.toThrow('越界');
    await expect(materializeFork(sourceDir, 0, target)).rejects.toThrow('越界');
    await expect(materializeFork(sourceDir, 1.5, target)).rejects.toThrow('越界');
  });

  it('源会话为空 → 抛错', async () => {
    await fsPromises.writeFile(path.join(sourceDir, 'conversation_full.jsonl'), '', 'utf-8');
    await expect(materializeFork(sourceDir, 1, path.join(tmpDir, 't4'))).rejects.toThrow('没有可分支的消息');
  });
});
