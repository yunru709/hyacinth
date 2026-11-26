/**
 * 过程块 / 工具输出**不得再出现内层纵向滚动**。
 *
 * 真实事故（2026-11-26 用户实报"滚到某处就上下不去"）：
 *   `.process-body { max-height: min(60vh,680px); overflow-y: auto }` 会在消息流里
 *   再套一个滚动容器：
 *     ① 滚轮落在块上时先滚内层，页面原地不动；
 *     ② **内层藏起来的像素不计入外层 scrollHeight**（实测 8196px 内容封顶 540px，
 *        7656px 不可达），页面滚到底也不代表内容到底。
 *   修法：裁切（overflow:hidden）+ 显式「展开全部」按钮（.is-expanded 解除封顶）。
 *
 * 判据：这两个选择器的主块里不许出现纵向 auto/scroll，且展开态规则必须存在。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS = 'src/webui/shell.css';
const src = fs.readFileSync(path.join(process.cwd(), CSS), 'utf8');

/** 取某个选择器**第一条**规则的声明体（够用：这些块都是简单平铺规则）。 */
function block(selector: string): string {
  const at = src.indexOf(`${selector} {`);
  if (at < 0) return '';
  const end = src.indexOf('}', at);
  return src.slice(at, end + 1);
}

const VERTICAL_SCROLL = /overflow-y:\s*(auto|scroll)/;

describe('过程块与工具输出不制造嵌套滚动', () => {
  it('.process-body 用裁切而不是内层滚动', () => {
    const body = block('.process-body');
    expect(body, '找不到 .process-body 规则').not.toBe('');
    expect(body).toContain('overflow: hidden');
    expect(body, '内层滚动会让滚轮被吃掉、且藏起来的像素不计入页面高度').not.toMatch(VERTICAL_SCROLL);
  });

  it('展开态解除封顶、交还外层滚动', () => {
    const expanded = block('.process-group.is-expanded > .process-body');
    expect(expanded, '缺少 .is-expanded 展开态规则').not.toBe('');
    expect(expanded).toContain('max-height: none');
    expect(expanded).toContain('overflow: visible');
  });

  it('运行中的过程块同样不封顶', () => {
    const live = block('.process-group.is-live > .process-body');
    expect(live).not.toBe('');
    expect(live).toContain('max-height: none');
  });

  it('.tool-card.is-open .tool-out 展开后不再自带滚动', () => {
    const out = block('.tool-card.is-open .tool-out');
    expect(out).not.toBe('');
    expect(out).toContain('max-height: none');
    expect(out).not.toMatch(VERTICAL_SCROLL);
  });

  it('守卫自身有效：能抓到「overflow-y: auto」的写法', () => {
    const bad = '.process-body { max-height: 540px; overflow-y: auto; }';
    expect(bad).toMatch(VERTICAL_SCROLL);
  });
});
