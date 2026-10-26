// breeze-tts-2 的纯函数单测：extras 白名单过滤 + 文本内非语言标签识别。
//
// 为什么单独测这两个：
//   · pickExtras 决定「哪些引擎特有参数能活到请求体」—— 白名单漏一个 = 能力用不上；
//     宽一个 = audio.cpp 整单失败（实测未知 option 报 unknown BreezeTTS request option 而非忽略）。
//   · hasInlineTags 决定「要不要自动切 tag_aware」—— 只有 tag_aware 才保证标签不被
//     长文本分块切断；漏判 = 用户写 [laughter] 静默失效，误判 = 无害（tag_aware 对无标签文本等价）。
import { describe, it, expect } from 'vitest';
import { pickExtras, hasInlineTags } from './breeze-tts2.js';

describe('pickExtras（extras 白名单）', () => {
  it('白名单内的键原样保留', () => {
    const out = pickExtras({ temperature: 0.7, top_k: 20, seed: 42, text_chunk_mode: 'tag_aware' });
    expect(out).toEqual({ temperature: 0.7, top_k: 20, seed: 42, text_chunk_mode: 'tag_aware' });
  });

  it('白名单外的键丢弃（只有白名单内的能活下来）', () => {
    const out = pickExtras({ temperature: 0.7, language: 'zh', voice: 'x', anything: 1 });
    expect(out).toEqual({ temperature: 0.7 });
    expect(Object.keys(out)).not.toContain('language');
  });

  it('instruct / reference_text 不进 extras（它们由 voice / emotion 派生，避免两个真源）', () => {
    const out = pickExtras({ instruct: '用开心的语气', reference_text: '稿子', seed: 1 });
    expect(out).toEqual({ seed: 1 });
  });

  it('undefined / null 值的键跳过（"传了但没值" ≡ 没传，别变成字符串 "null"）', () => {
    const out = pickExtras({ temperature: undefined, top_k: null, seed: 0 });
    expect(out).toEqual({ seed: 0 });
    // 0 是合法值，不能被当成 falsy 丢掉
    expect(Object.keys(out)).toContain('seed');
  });

  it('undefined 输入 → 空对象（不抛错）', () => {
    expect(pickExtras(undefined)).toEqual({});
  });

  it('全部是白名单外 → 空对象（调用方据此判断要不要设 body.options）', () => {
    expect(pickExtras({ foo: 1, bar: 2 })).toEqual({});
  });

  it('12 个合法键全部放行（逐字对应 model_specs 的 request options）', () => {
    const all = {
      text_chunk_size: 600,
      text_chunk_mode: 'tag_aware',
      max_tokens: 1500,
      guidance_scale: 1.0,
      temperature: 0.9,
      depth_temperature: 0.9,
      top_k: 50,
      top_p: 1,
      seed: 0,
      stream_frames_per_event: 16,
      stream_lookahead_margin: 0,
      stream_chunk_policy: 'grow',
    };
    expect(pickExtras(all)).toEqual(all);
  });
});

describe('hasInlineTags（非语言标签识别）', () => {
  it('方括号标签：[laughter] / [laugh] / [sigh]', () => {
    expect(hasInlineTags('今天真好[laughter]')).toBe(true);
    expect(hasInlineTags('[laugh]')).toBe(true);
    expect(hasInlineTags('唉[sigh]')).toBe(true);
  });

  it('尖括号标签：<laugh>（实测时长增加最明显）', () => {
    expect(hasInlineTags('今天真好<laugh>')).toBe(true);
  });

  it('中文全角括号（笑）**不识别**（实测无效，只 +0.16s 属噪声）', () => {
    expect(hasInlineTags('今天真好（笑）')).toBe(false);
  });

  it('普通不含标签的口语文本 → false', () => {
    expect(hasInlineTags('今天天气不错，我们出去走走吧。')).toBe(false);
    expect(hasInlineTags('这是一句很长的话，里面没有任何方括号或尖括号标记。')).toBe(false);
  });

  it('空字符串 → false', () => {
    expect(hasInlineTags('')).toBe(false);
  });

  it('超长标签（>24 字符）不识别 —— 多半是正文而非控制标记', () => {
    const long = '[' + 'x'.repeat(30) + ']';
    expect(hasInlineTags(long)).toBe(false);
  });

  it('跨行标签不识别（标签必须在同一行内）', () => {
    expect(hasInlineTags('[la\nugh]')).toBe(false);
  });
});
