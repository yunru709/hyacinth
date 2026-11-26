/**
 * 输入框自适应高度守卫。
 *
 * 真实事故（2026-11-26 用户实报）：
 *   输入三行内容 → 发送 → 文字消失了，但输入框仍然是三行高，要等下一次按键
 *   （input 事件）才收回去。
 *
 * 病因：autoGrow 只挂在 `input` 事件上，而清空走的是程序赋值
 *   `input.value = ''` —— 内联 `style.height` 不会被 value 清空影响，
 *   于是留下一个空的多行盒子。
 *
 * 判据（只锁行为契约，不锁实现细节）：
 *   凡是"发送并清空输入框"的函数，体内必须出现 fitTextarea(...) 调用。
 *   位置判据用花括号配对切出函数体，避免整文件正则误伤（app.js 里还有别处
 *     `input.value = ''`，例如文件选择器，那个不需要重算高度）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP = 'src/webui/app.js';

/** 从 `function <name>(` 起按花括号配对切出函数体（跳过字符串/注释的粗粒度实现，
 *  对这些函数足够：它们体内没有含 `{`/`}` 的模板字符串）。 */
function extractFunctionBody(src: string, name: string): string | null {
  const head = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!head) return null;
  const open = src.indexOf('{', head.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

describe('输入框清空后必须重算高度', () => {
  const src = fs.readFileSync(path.join(process.cwd(), APP), 'utf8');

  it('fitTextarea 存在且是唯一的高度计算入口', () => {
    expect(src).toContain('function fitTextarea(');
    // 直接写 style.height 的地方应当只有 fitTextarea 自己（避免又长出一份重复逻辑）
    const direct = [...src.matchAll(/\.style\.height\s*=/g)].length;
    expect(direct).toBeLessThanOrEqual(2); // fitTextarea 内的两行：'auto' 与具体值
  });

  it.each(['sendChat', 'sendCompanion'])('%s 清空输入框后调用了 fitTextarea', (fn) => {
    const body = extractFunctionBody(src, fn);
    expect(body, `${fn} 未找到`).not.toBeNull();
    expect(body).toContain("value = ''");
    expect(body, `${fn} 清空 value 后没有重算高度 ⇒ 会留下空的多行盒子`).toContain('fitTextarea(');
  });

  it('守卫自身有效：能抓到「只清空不重算」的形态', () => {
    const sample = `
      function sendChat() {
        const input = document.querySelector('#chat-input');
        input.value = '';
      }`;
    const body = extractFunctionBody(sample, 'sendChat')!;
    expect(body).toContain("value = ''");
    expect(body).not.toContain('fitTextarea(');
  });
});
