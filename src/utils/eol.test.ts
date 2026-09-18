import { describe, expect, it } from 'vitest';
import { detectEol, toLf, applyEol, adaptEolTo } from './eol.js';

describe('detectEol', () => {
  it('按多数派判定：CRLF 文件', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('\r\n');
  });
  it('按多数派判定：LF 文件', () => {
    expect(detectEol('a\nb\nc\n')).toBe('\n');
  });
  it('混合时取多数派（一处裸 LF 不足以把 CRLF 文件判成 LF）', () => {
    expect(detectEol('a\r\nb\r\nc\nd\r\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\nd\n')).toBe('\n');
  });
  it('无换行 → LF（新建文件默认）', () => {
    expect(detectEol('single line')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });
});

describe('toLf / applyEol', () => {
  it('toLf 折平 CRLF，且不误伤孤立 CR', () => {
    expect(toLf('a\r\nb\nc')).toBe('a\nb\nc');
    expect(toLf('a\rb')).toBe('a\rb');
  });
  it('applyEol 往返一致', () => {
    const crlf = 'x\r\ny\r\n';
    expect(applyEol(toLf(crlf), '\r\n')).toBe(crlf);
    const lf = 'x\ny\n';
    expect(applyEol(lf, '\n')).toBe(lf);
    expect(applyEol('x\ny\n', '\r\n')).toBe('x\r\ny\r\n');
  });
});

describe('adaptEolTo', () => {
  it('把 LF 文本适配成 CRLF 文件风格，且结果不含裸 LF', () => {
    const out = adaptEolTo('line1\nline2\n', 'orig\r\nfile\r\n');
    expect(out).toBe('line1\r\nline2\r\n');
    // 逐字节确认：不存在"前一个字符不是 \r 的 \n"
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '\n') expect(out[i - 1]).toBe('\r');
    }
  });

  it('LF 文件保持 LF', () => {
    expect(adaptEolTo('a\nb\n', 'orig\nfile\n')).toBe('a\nb\n');
  });

  it('新建文件（fileContent 为空）→ LF', () => {
    expect(adaptEolTo('a\r\nb\r\n', '')).toBe('a\nb\n');
  });
});
