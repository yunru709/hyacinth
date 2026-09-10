/**
 * tui-ask-user.test.ts —— Ask User 表单控制器单测（tui.ts 深拆第三批）。
 *
 * 覆盖迁移自 runTui 闭包的全部行为：打开/关闭、tab 切换、选项导航、
 * 单选互斥、多选、自定义输入缓存、Enter 提交（本地 resolve 与协议双通道）、
 * Escape 取消（本地/协议）。Text/ChatLog/TUI 均以最小 mock 替换。
 *
 * 注：handleKey 的 data 与生产 addInputListener 一致，是终端原始输入字节
 * （Enter='\r'、上箭头='\u001b[A'、空格=' ' 等），matchesKey 内部解析为 keyId。
 */

import { describe, expect, it, vi } from 'vitest';
import { Key } from '@earendil-works/pi-tui';
import { createTuiAskUser } from './tui-ask-user.js';
import type { AskUserQuestion } from './tui-ask-user.js';
import type { Text, TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';

// 终端原始输入字节（matchesKey 第一参）
const ENTER = '\r';
const ESC = '\u001b';
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const SPACE = ' ';
const PAGEUP = '\u001b[5~';

/** Text 最小 mock：记录 setText 内容 */
class MockText {
  value = '';
  setText(t: string): void { this.value = t; }
}

function setup() {
  const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
  const chatLog = { addSystem: vi.fn() } as unknown as Pick<ChatLog, 'addSystem'>;
  const askUserContent = new MockText();
  const askUserBar = new MockText();
  const protocolSend = vi.fn(async () => undefined);
  const ctl = createTuiAskUser({
    tui,
    chatLog,
    askUserContent: askUserContent as unknown as Text,
    askUserBar: askUserBar as unknown as Text,
    protocolSend,
  });
  return { ctl, tui, chatLog, askUserContent, askUserBar, protocolSend };
}

const Q1: AskUserQuestion = { question: '选择模式?', options: ['A', 'B', 'C'], header: '模式' };
const Q2: AskUserQuestion = { question: '喜欢的颜色?', options: ['红', '绿'], multiSelect: true, header: '颜色' };

describe('tui-ask-user 表单控制器', () => {
  it('open 后 hasPending 为 true，且渲染出内容与导航条', () => {
    const { ctl, askUserContent, askUserBar } = setup();
    expect(ctl.hasPending()).toBe(false);
    ctl.open([Q1], { resolve: () => {} });
    expect(ctl.hasPending()).toBe(true);
    expect(askUserContent.value).toContain('选择模式?');
    expect(askUserBar.value).toContain('←→');
  });

  it('Enter 提交：本地通道走 resolve，返回选中项 JSON 且表单关闭', () => {
    const { ctl } = setup();
    let answer = '';
    ctl.open([Q1], { resolve: (a) => { answer = a; } });
    // 选中第 2 项（B）
    ctl.handleKey(DOWN);
    ctl.handleKey(SPACE);
    ctl.handleKey(ENTER);
    const parsed = JSON.parse(answer);
    expect(parsed['选择模式?']).toEqual(['B']);
    expect(ctl.hasPending()).toBe(false);
  });

  it('单选互斥：选中 B 后再选 A，只保留 A', () => {
    const { ctl } = setup();
    let answer = '';
    ctl.open([Q1], { resolve: (a) => { answer = a; } });
    ctl.handleKey(DOWN);  // → B
    ctl.handleKey(SPACE);
    ctl.handleKey(UP);    // → A
    ctl.handleKey(SPACE);
    ctl.handleKey(ENTER);
    const parsed = JSON.parse(answer);
    expect(parsed['选择模式?']).toEqual(['A']);
  });

  it('多选可同时勾选多项', () => {
    const { ctl } = setup();
    let answer = '';
    ctl.open([Q2], { resolve: (a) => { answer = a; } });
    ctl.handleKey(SPACE); // 红
    ctl.handleKey(DOWN);
    ctl.handleKey(SPACE); // 绿
    ctl.handleKey(ENTER);
    const parsed = JSON.parse(answer);
    expect(parsed['喜欢的颜色?'].sort()).toEqual(['红', '绿']);
  });

  it('tab 切换：Left/Right 在问题与补充 tab 间循环', () => {
    const { ctl, askUserBar } = setup();
    ctl.open([Q1, Q2], { resolve: () => {} });
    // 初始在问题0；右两次 → 补充（questions.length=2）
    ctl.handleKey(RIGHT);
    ctl.handleKey(RIGHT);
    expect(askUserBar.value).toContain('提交全部');
    // 再右 → 回到问题0
    ctl.handleKey(RIGHT);
    expect(askUserBar.value).toContain('←→ 切换');
  });

  it('自定义输入：打字进入缓存，Enter 提交合并进答案', () => {
    const { ctl } = setup();
    let answer = '';
    const q: AskUserQuestion = { question: '补充想法?', customInput: true };
    ctl.open([q], { resolve: (a) => { answer = a; } });
    ctl.handleKey('我');
    ctl.handleKey('想');
    ctl.handleKey(ENTER);
    const parsed = JSON.parse(answer);
    expect(parsed['补充想法?']).toEqual(['我想']);
  });

  it('补充 tab：自由输入以「补充说明」键提交', () => {
    const { ctl } = setup();
    let answer = '';
    ctl.open([Q1], { resolve: (a) => { answer = a; } });
    ctl.handleKey(RIGHT); // → 补充 tab
    ctl.handleKey('自');
    ctl.handleKey('由');
    ctl.handleKey(ENTER);
    const parsed = JSON.parse(answer);
    expect(parsed['补充说明']).toEqual(['自由']);
  });

  it('协议通道：传入 id 时 Enter 提交走 protocolSend(askUserResolve)', () => {
    const { ctl, protocolSend } = setup();
    ctl.open([Q1], { id: 'req-1' });
    ctl.handleKey(SPACE); // A
    ctl.handleKey(ENTER);
    expect(protocolSend).toHaveBeenCalledWith('message.askUserResolve', {
      id: 'req-1',
      answer: expect.stringContaining('选择模式?'),
    });
    expect(ctl.hasPending()).toBe(false);
  });

  it('Escape 取消：协议通道回传空答案 {}，本地通道 resolve({})', () => {
    const { ctl, protocolSend } = setup();
    // 协议通道
    ctl.open([Q1], { id: 'req-2' });
    ctl.handleKey(ESC);
    expect(protocolSend).toHaveBeenCalledWith('message.askUserResolve', { id: 'req-2', answer: '{}' });
    expect(ctl.hasPending()).toBe(false);
    // 本地通道
    let answer = 'unset';
    ctl.open([Q1], { resolve: (a) => { answer = a; } });
    ctl.handleKey(ESC);
    expect(answer).toBe('{}');
  });

  it('表单激活期所有按键均被消费（handleKey 不抛错）', () => {
    const { ctl } = setup();
    ctl.open([Q2], { resolve: () => {} });
    expect(() => {
      ctl.handleKey(ENTER);
      ctl.open([Q1], { resolve: () => {} });
      ctl.handleKey(PAGEUP);
      ctl.handleKey(DOWN);
    }).not.toThrow();
  });

  it('未激活时 handleKey 为空操作（不影响后续使用）', () => {
    const { ctl, protocolSend } = setup();
    ctl.handleKey(ENTER);
    expect(protocolSend).not.toHaveBeenCalled();
    expect(ctl.hasPending()).toBe(false);
  });
});
