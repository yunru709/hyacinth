import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolResultBuffer, stripInlineMedia } from './result-buffer.js';

/**
 * 上下文爆炸事故回归测试（2026-10-29）。
 *
 * 事故链：windows-mcp 的 Snapshot 返回 image block（base64 PNG）→ MCP 客户端把它
 * JSON.stringify 成纯文本 → 单条 78 万字符（≈20 万 tokens）进入对话历史 →
 * 压缩时再复制一份 → 上下文 1.1M > 模型 1M 窗口 → 上游只回
 * `400 "Model is unavailable"`（与模型下线共用同一句报错，极易误诊）。
 *
 * ⚠️ 构造测试数据时必须用**真实形态**：一整串连续的 base64（只在最末尾可能有一个
 * `=` 或 `==` 的 padding）。若像分块 PNG 那样每百来字符插一次 `==`，正则的连续匹配
 * 会在此处断开，测出来的"通过"是假绿 —— 这条弯路已踩过一次。
 */

/** 真实形态的 base64：连续无中断，仅末尾补 padding。 */
function realBase64(len: number): string {
  const core = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ';
  return core.repeat(Math.ceil(len / core.length)).slice(0, len);
}

const BIG_B64 = realBase64(100_000);      // ≈100 KB
const HUGE_B64 = realBase64(780_000);     // ≈780 KB —— 与事故中的实际体量同量级

function newBuffer(overrides: { threshold?: number; enabled?: boolean } = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), 'hyacinth-rb-'));
  return new ToolResultBuffer({ sessionDir, ...overrides });
}

describe('stripInlineMedia — 内联 base64 剥离', () => {
  it('剥掉 MCP image block 被 JSON 化后的 "data" 字段', () => {
    const raw = `[ToolResult: call_x] 1\u2192 Cursor Position: (1532, 1274)\n{"type":"image","data":"${BIG_B64}","mimeType":"image/png"}`;
    const out = stripInlineMedia(raw);

    expect(out).not.toContain(BIG_B64.slice(0, 512));
    expect(out).toContain('[base64 omitted:');
    // 文本部分必须原样保留 —— 剥离只能牺牲像素数据
    expect(out).toContain('Cursor Position: (1532, 1274)');
    expect(out).toContain('"mimeType":"image/png"');
  });

  it('剥掉 data URI 形态的 base64', () => {
    const raw = `screenshot: data:image/png;base64,${BIG_B64}`;
    const out = stripInlineMedia(raw);
    expect(out).not.toContain(BIG_B64.slice(0, 512));
    expect(out).toContain('[inline image/png base64 omitted:');
  });

  it('剥掉超长裸 base64（兜底路径，非 JSON 形态）', () => {
    const raw = `raw blob: ${realBase64(30_000)}`;
    const out = stripInlineMedia(raw);
    expect(out).toContain('[base64 omitted:');
    expect(out.length).toBeLessThan(200);
  });

  it('短 base64 与非媒体长文本不受影响（零误伤）', () => {
    const shortB64 = 'abc123+/=';
    const longCode = 'const a = 1; '.repeat(50) + 'x'.repeat(5000);
    expect(stripInlineMedia(shortB64)).toBe(shortB64);
    expect(stripInlineMedia(longCode)).toBe(longCode);
  });

  it('普通中文/日志文本完全不变', () => {
    const text = '构建失败：src/index.ts:42 类型不匹配\n[Exit code: 1]';
    expect(stripInlineMedia(text)).toBe(text);
  });
});

describe('ToolResultBuffer.maybeBuffer — 事故防线', () => {
  it('78 万字符的截图结果：注入历史的部分必须远小于原文', () => {
    const buffer = newBuffer();
    const raw = `[ToolResult: call_x]\n{"type":"image","data":"${HUGE_B64}","mimeType":"image/png"}`;
    expect(raw.length).toBeGreaterThan(700_000);

    const out = buffer.maybeBuffer(raw, 'mcp__windows-mcp__Snapshot');

    expect(out.length).toBeLessThan(20_000);          // 绝不整段进历史
    expect(out).not.toContain(HUGE_B64.slice(0, 512)); // base64 必须消失
    // 剥离后已远小于阈值 ⇒ 不再落盘（少一个无谓文件），但必须带省略标注
    expect(out).toContain('[base64 omitted:');
    // 非媒体文本必须原样保留
    expect(out).toContain('"mimeType":"image/png"');
  });

  it('含 base64 但剥离后已小于阈值的，不再落盘（避免无谓文件）', () => {
    const buffer = newBuffer({ threshold: 10_000 });
    const raw = `small shot: {"type":"image","data":"${realBase64(5000)}","mimeType":"image/png"}`;
    const out = buffer.maybeBuffer(raw, 'mcp__x__Screenshot');
    expect(out).toContain('[base64 omitted:');
    expect(out).not.toContain('[Result Buffered');
  });

  it('关闭缓冲时不剥离（保持原行为，供排查）', () => {
    const buffer = newBuffer({ enabled: false });
    const raw = `{"type":"image","data":"${BIG_B64}","mimeType":"image/png"}`;
    expect(buffer.maybeBuffer(raw, 'x')).toBe(raw);
  });
});
