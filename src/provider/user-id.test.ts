/**
 * user-id 单测 —— 重点守「**新使用点的兜底契约**」（2026-10-02）。
 *
 * 背景：隔离 id 此前是一份手写清单，新增调用点若忘了配就会静默落进
 * `DEFAULT_USER_ID` 全局池，与别的"忘配"调用点互相挤占 KVCache
 * （症状：聊到一半突然变慢变贵，归因极难）。现在无专属函数者一律 `derivedUserId` 派生。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_USER_ID,
  companionUserId,
  compressorUserId,
  derivedUserId,
  mainUserId,
  narrationUserId,
  orchestratorUserId,
  setUserIdPrefix,
  subAgentUserId,
} from './user-id.js';

afterEach(() => {
  // 前缀是模块级全局状态 ⇒ 每个用例后复原，避免污染其它测试
  setUserIdPrefix(DEFAULT_USER_ID);
});

describe('derivedUserId（新使用点的兜底契约）', () => {
  it('按调用点名派生，前缀跟随 setUserIdPrefix', () => {
    expect(derivedUserId('my-feature')).toBe('hyacinth-my-feature');
    setUserIdPrefix('myapp');
    expect(derivedUserId('my-feature')).toBe('myapp-my-feature');
  });

  it('清洗：大写转小写、非法字符折成 -、连续折一个、首尾去 -', () => {
    expect(derivedUserId('Some Plugin/Feature')).toBe('hyacinth-some-plugin-feature');
    expect(derivedUserId('a..b__c')).toBe('hyacinth-a..b__c'); // . 与 _ 是合法保留字符
    expect(derivedUserId('a   b')).toBe('hyacinth-a-b');
  });

  it('中文角色名保留（否则多个中文名会撞成同一个池）', () => {
    expect(derivedUserId('柔柔')).toBe('hyacinth-柔柔');
    expect(derivedUserId('柔柔')).not.toBe(derivedUserId('小雪'));
  });

  it('空/全非法字符 → unknown 哨兵（仍是一个确定的池，不是全局池）', () => {
    expect(derivedUserId('')).toBe('hyacinth-unknown');
    expect(derivedUserId(':::')).toBe('hyacinth-unknown');
    expect(derivedUserId('!!!')).not.toBe(DEFAULT_USER_ID);
  });

  it('同名角色派生值与对应具名函数一致（单一出口，不出现两套命名）', () => {
    expect(derivedUserId('orchestrator')).toBe(orchestratorUserId());
    expect(derivedUserId('narration')).toBe(narrationUserId());
    expect(derivedUserId('compressor')).toBe(compressorUserId());
  });

  it('带 tag 的具名函数仍是更细粒度（派生不会替代它）', () => {
    expect(mainUserId('sess-1')).toBe('hyacinth-main-sess-1');
    expect(subAgentUserId('reviewer', 'i1')).toBe('hyacinth-sub-reviewer-i1');
    expect(derivedUserId('main')).not.toBe(mainUserId('sess-1'));
    expect(companionUserId('柔柔')).toBe('hyacinth-companion-柔柔');
  });
});
