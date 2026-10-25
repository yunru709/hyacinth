// ============================================================
// 事件落盘顺序回归测试
// ============================================================
// 背景：orchestrator 对流式片段调用 appendEvent 时不 await。
// 旧实现直接 fs.appendFile ⇒ 完成顺序不受控 ⇒ 历史回放拼出乱序文本。
// 该测试固定「调用顺序 == 文件顺序」这一契约。
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, type ConversationEvent } from './events.js';

let tmpDir: string;

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('appendEvent ordering', () => {
  it('并发 fire-and-forget 调用仍按调用顺序落盘', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyacinth-events-'));

    // 模拟逐 token 流：故意不 await（与 llm 阶段一致）
    const count = 300;
    let last: Promise<void> | undefined;
    for (let i = 0; i < count; i++) {
      const evt: ConversationEvent = {
        type: 'text',
        content: `chunk-${String(i).padStart(3, '0')};`,
        timestamp: '2026-10-25T00:00:00.000Z',
      };
      last = appendEvent(tmpDir, evt);
    }
    await last; // 等队尾完成 ⇒ 队列内所有写已落盘

    const raw = (await fs.readFile(path.join(tmpDir, 'events.jsonl'), 'utf-8')).trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(count);
    const contents = lines.map((line) => (JSON.parse(line) as ConversationEvent).content);
    expect(contents).toEqual(Array.from({ length: count }, (_, i) => `chunk-${String(i).padStart(3, '0')};`));
  });
});
