import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { MCPClient } from './client.js';

/**
 * MCP content block 序列化回归测试（2026-10-29 上下文爆炸事故）。
 *
 * 事故：windows-mcp 的 Snapshot 返回 `[{type:'text'},{type:'image',data:<base64>,mimeType}]`。
 * 旧实现 `JSON.stringify(block)` 把 628 KB 的 PNG 变成 78 万字符纯文本注入历史
 * （≈20 万 tokens），压缩时再复制一份 ⇒ 上下文 1.1M > 1M 窗口 ⇒ 上游 400
 * "Model is unavailable"（误导性通用报错）。
 *
 * 不变量：**image 的 base64 永远不出现在注入历史的分支里**。
 */

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BIG_B64 = B64.replace(/=/g, '').repeat(8_000); // ≈780 KB，连续无 padding 中断

function newClient() {
  // 构造函数只保存 config，不会发起连接 —— 可直接用于纯函数测试
  return new MCPClient({ name: 'test-server', command: 'noop' });
}

type Formatter = (block: unknown) => string;
const format = (c: MCPClient, block: unknown): string =>
  (c as unknown as { formatContentBlock: Formatter }).formatContentBlock(block);

describe('MCPClient.formatContentBlock — image 绝不内联', () => {
  it('image 块的 base64 不出现在返回值中，改为落盘路径', () => {
    const out = format(newClient(), { type: 'image', data: BIG_B64, mimeType: 'image/png' });

    expect(out.length).toBeLessThan(1000);                 // 不再是 78 万字符
    expect(out).not.toContain(BIG_B64.slice(0, 512));      // base64 必须消失
    expect(out).toMatch(/\[Image saved: .+\.png \(image\/png, [\d.]+ KB\)/);    // 给出可用路径
    expect(out).toContain('read(file_path=');

    // 落盘文件必须真实存在且字节数合理（≈585 KB 的 PNG 数据）
    const path = out.match(/\[Image saved: (.+?) \(/)?.[1];
    expect(path && existsSync(path)).toBe(true);
    const bytes = readFileSync(path!).length;
    expect(bytes).toBeGreaterThan(500_000);
  });

  it('同一张图重复出现时按内容去重（不重复写盘）', () => {
    const client = newClient();
    const a = format(client, { type: 'image', data: BIG_B64, mimeType: 'image/png' });
    const b = format(client, { type: 'image', data: BIG_B64, mimeType: 'image/png' });
    expect(a).toBe(b);
  });

  it('text 块原样返回', () => {
    const text = 'Cursor Position: (1532, 1274)\nScreenshot Original Size: (2560,1440)';
    expect(format(newClient(), { type: 'text', text })).toBe(text);
  });

  it('未知块类型必须截断，不得把大 payload 原样带出', () => {
    const out = format(newClient(), { type: 'audio', data: BIG_B64, mimeType: 'audio/wav' });
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain('[block truncated');
  });

  it('image 但无 data（仅 url）时不崩、不内联', () => {
    const out = format(newClient(), {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    });
    expect(out).toContain('[Image: image/png');
    expect(out).not.toContain('data:image');
  });

  it('空块/非对象输入不抛异常', () => {
    const client = newClient();
    expect(format(client, null)).toBe('');
    expect(format(client, undefined)).toBe('');
    expect(format(client, 'plain')).toBe('plain');
  });
});
