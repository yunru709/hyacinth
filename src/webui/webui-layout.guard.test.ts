/**
 * WebUI 布局结构守卫。
 *
 * 真实事故（2026-10-27）：6 个 `<section data-view="…">` 被浏览器解析成
 * `#app-shell` 的**直属子元素**（而不是 `<main id="hyacinth-main">` 的后代），
 * 它们带 `.h-full`（height:100%）⇒ 相对 `#app-shell` 撑满 ⇒ 主体区高度塌成 0，
 * 表现为「一切到设置/模型页，整块内容消失」。
 *
 * 当时的修法是一个运行时补丁 `normalizeViewSections()`：启动时把游离在
 * `#app-shell` 下、`#hyacinth-main` 之外的 `section.view-section` 收进 main。
 *
 * 2026-11-19 审计的自我纠错：第一版判定该补丁"空转"并删除了它，本文件随即抓到
 * `section[data-view="companion"]`（index.html:1874）位于 `</main>`(1749) 之后
 * ⇒ 补丁其实每次启动都在给 companion 归一位置，用户看到的陪伴布局是补丁后的结果。
 * 补丁已恢复，本文件负责锁住**其余**视图的结构：谁再被解析到 main 之外，门禁即红，
 * 而不是等用户看见白屏。
 *
 * 判据只认「位置关系」，不做 HTML 树解析：
 *   每个 `<section …data-view…>` 的开标签都必须落在 `id="hyacinth-main"` 与
 *   它的 `</main>` 之间。
 * 为什么不用标签栈：index.html 里有大量 SVG 子元素与可省略闭合的写法，
 * 手写的栈很容易因一个 `<path>` 错位就把 `<main>` 误弹出，得到满屏假阳性
 * （2026-11-19 实测：第一版栈解析把 20+ 个 section 全判成游离）。
 * 原事故的形态本来就是「section 出现在 </main> 之后」，位置判据足够锁住它。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HTML_PATH = 'src/webui/index.html';
const APP_PATH = 'src/webui/app.js';

/** 剔除注释与 <style>/<script> 内容：只在"是否还有那个标签"这个问题上做减法 */
function stripNonMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<script[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '));
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

describe('WebUI 布局结构：视图 section 必须位于 #hyacinth-main 内', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), HTML_PATH), 'utf8');
  const html = stripNonMarkup(raw);

  const mainOpen = html.indexOf('id="hyacinth-main"');
  const mainClose = html.indexOf('</main>', mainOpen < 0 ? 0 : mainOpen);

  it('#hyacinth-main 存在且有闭合（结构前提成立，否则下面全无意义）', () => {
    expect(mainOpen).toBeGreaterThan(0);
    expect(mainClose).toBeGreaterThan(mainOpen);
  });

  it('除 companion 外的 section 开标签都在 #hyacinth-main 的开闭之间', () => {
    const opens = [...html.matchAll(/<section\b[^>]*>/g)].map((m) => ({
      at: m.index as number,
      tag: m[0],
    }));
    expect(opens.length).toBeGreaterThanOrEqual(6);   // 守卫自身有效：确实扫到了视图

    // companion 是**有意的例外**：它是全屏沉浸视图，与 #preview-dock 一样写在
    // </main> 之后、#app-shell 之内，由 app.js 的 normalizeViewSections() 在启动时
    // 收进 main（见该函数注释）。判据只锁"被浏览器解析错位"的那类回退。
    const EXEMPT_VIEWS = new Set(['companion']);
    const viewOf = (tag: string) => (tag.match(/data-view="([^"]+)"/) || [])[1] || '';

    const stray = opens.filter((o) => {
      const outside = o.at < mainOpen || o.at > mainClose;
      return outside && !EXEMPT_VIEWS.has(viewOf(o.tag));
    });
    const msg = stray
      .map((o) => `${HTML_PATH}:${lineOf(html, o.at)} 游离在 #hyacinth-main 之外 → ${o.tag.slice(0, 80)}`)
      .join('\n');
    expect(msg).toBe('');
  });

  it('视图 section 带 data-view（导航按它切换，缺了就是不可达页面）', () => {
    const viewSections = [...html.matchAll(/<section\b[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);
    for (const required of ['chat', 'settings', 'sessions', 'schedule']) {
      expect(viewSections).toContain(required);
    }
  });

  it('运行时补丁 normalizeViewSections 必须存在（companion 视图靠它归位）', () => {
    // 反转说明（2026-11-19 审计自我纠错）：审计第一版判定它是"空转代码"并删除，
    // 本测试随即抓到 section[data-view="companion"] @index.html:1874 在 </main> 之后
    // ⇒ 补丁每次启动都在把它收进 main，用户看到的陪伴布局是补丁后的结果。
    // 删掉 = 改变实际布局。故此断言改为「必须保留」，防止下一次"清理"再删它。
    const app = fs.readFileSync(path.join(process.cwd(), APP_PATH), 'utf8');
    expect(app).toContain('function normalizeViewSections');
  });

  it('守卫自身有效：能抓到「section 被甩到 </main> 之后」的形态', () => {
    const bad = '<body><main id="hyacinth-main"><section data-view="chat"></section></main>'
      + '<section data-view="settings"></section></body>';
    const h = stripNonMarkup(bad);
    const o = h.indexOf('id="hyacinth-main"');
    const c = h.indexOf('</main>', o);
    const opens = [...h.matchAll(/<section\b[^>]*>/g)].map((m) => m.index as number);
    const stray = opens.filter((at) => at < o || at > c);
    expect(stray.length).toBe(1);
  });
});
