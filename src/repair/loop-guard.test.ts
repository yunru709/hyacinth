import { ToolGuard, TextGuard, LoopGuard, isMutating } from './loop-guard.js';

describe('LoopGuard', () => {
  describe('ToolGuard', () => {
    it('suppresses after threshold identical calls', () => {
      const guard = new ToolGuard({ enabled: true, windowSize: 6, threshold: 3, exemptTools: [] });
      const call = { id: '1', name: 'session_stats', input: {} };

      guard.check([call]);  // 1st
      guard.check([call]);  // 2nd
      expect(guard.check([call]).size).toBe(1);   // 3rd → suppressed
    });

    it('resets window after reset()', () => {
      const guard = new ToolGuard({ enabled: true, windowSize: 6, threshold: 3, exemptTools: [] });
      const call = { id: '1', name: 'session_stats', input: {} };
      guard.check([call]); // 1
      guard.check([call]); // 2
      guard.reset();
      guard.check([call]); // after reset → 1 again, not suppressed
      expect(guard.check([call]).size).toBe(0); // only 2 after reset
    });

    it('exempt tools never trigger suppression', () => {
      const guard = new ToolGuard({ enabled: true, windowSize: 6, threshold: 2, exemptTools: ['read'] });
      const call = { id: '1', name: 'read', input: {} };
      for (let i = 0; i < 5; i++) {
        expect(guard.check([call]).size).toBe(0);
      }
    });

    it('mutating tools clear the window', () => {
      const guard = new ToolGuard({ enabled: true, windowSize: 6, threshold: 3, exemptTools: [] });
      const readCall = { id: '1', name: 'session_stats', input: {} };
      guard.check([readCall]); // 1
      guard.check([readCall]); // 2

      // write clears the window
      const writeCall = { id: '2', name: 'write', input: { file_path: '/tmp/x' } };
      guard.check([writeCall]);

      // back to session_stats → need 3 fresh calls to re-trigger
      guard.check([readCall]); // new 1
      guard.check([readCall]); // new 2
      expect(guard.check([readCall]).size).toBe(1); // new 3 → suppressed (threshold=3)
    });
  });

  describe('TextGuard', () => {
    it('detects repeated identical text', () => {
      const guard = new TextGuard({ enabled: true, windowSize: 6, threshold: 2, minLength: 30, similarity: 0.90 });
      const text = 'The system is currently processing the request and analyzing the output data from the previous step.';
      guard.check(text); // streak 0→0 (maxSim=0 < 0.9)
      guard.check(text); // streak 0→1 (maxSim=1.0)
      expect(guard.check(text)).toBe(true); // streak 1→2, 2>=2 → loop
    });

    it('skips short text', () => {
      const guard = new TextGuard({ enabled: true, windowSize: 6, threshold: 2, minLength: 30, similarity: 0.90 });
      expect(guard.check('OK')).toBe(false);
      expect(guard.check('OK')).toBe(false);
      expect(guard.check('OK')).toBe(false); // all false (below minLength)
    });

    it('resets streak after dissimilar text', () => {
      const guard = new TextGuard({ enabled: true, windowSize: 6, threshold: 2, minLength: 30, similarity: 0.90 });
      const text = 'The system is currently processing the request and analyzing the output data from the previous step.';
      guard.check(text);
      guard.check(text);
      expect(guard.check(text)).toBe(true); // 3rd → loop

      guard.reset();
      expect(guard.check(text)).toBe(false); // after reset → fresh
    });

    it('respects enabled: false', () => {
      const guard = new TextGuard({ enabled: false, windowSize: 6, threshold: 2, minLength: 30, similarity: 0.90 });
      const text = 'The system is currently processing the request and analyzing the data thoroughly for correctness.';
      for (let i = 0; i < 5; i++) guard.check(text);
      // all false because disabled
      const guard2 = new TextGuard({ enabled: true, windowSize: 6, threshold: 2, minLength: 30, similarity: 0.90 });
      guard2.check(text);
      guard2.check(text);
      expect(guard2.check(text)).toBe(true);
    });

    it('detects loop with only minor variation (time-stamp / numbering changes)', () => {
      // 真实循环形态：文本几乎相同但时间戳/编号微变（修复前 0.90 阈值 + 单词 Jaccard 漏拦）
      const guard = new TextGuard({ enabled: true, windowSize: 6, threshold: 3, minLength: 15, similarity: 0.70 });
      const mk = (ts: string) => `收到（${ts}）。继续实施 token 总量显示——最后接上 TUI。`;
      guard.check(mk('15:34'));
      guard.check(mk('15:35'));
      guard.check(mk('15:36'));
      guard.check(mk('15:37'));
      expect(guard.check(mk('15:38'))).toBe(true); // 微变循环第 5 次应触发
    });

    it('detects Chinese short-text loop (CJK bigram similarity)', () => {
      // 中文短句循环：英文单词 Jaccard 失真，字符 bigram 兜底
      const guard = new TextGuard({ enabled: true, windowSize: 6, threshold: 2, minLength: 8, similarity: 0.70 });
      const text = '让我重试一下这个操作';
      guard.check(text);
      guard.check(text);
      expect(guard.check(text)).toBe(true); // 3 次相同 → 触发
    });

    it('does not false-positive on distinct text (lowered threshold still safe)', () => {
      const guard = new TextGuard({ enabled: true, windowSize: 6, threshold: 3, minLength: 15, similarity: 0.70 });
      const distinct = [
        'The system is processing the request and analyzing the output data from the previous step.',
        'Now I will write the configuration file and then verify the changes are applied correctly.',
        'The error message indicates a network timeout when connecting to the remote server.',
        'Let me check the git log to understand what changed in the last few commits.',
        'I found the bug in the loop logic and will apply a fix to the retry mechanism.',
      ];
      for (const t of distinct) {
        expect(guard.check(t)).toBe(false);
      }
    });
  });

  describe('isMutating', () => {
    it('built-in mutating tools', () => {
      expect(isMutating('write')).toBe(true);
      expect(isMutating('edit')).toBe(true);
      expect(isMutating('bash')).toBe(true);
      expect(isMutating('read')).toBe(false);
      expect(isMutating('grep')).toBe(false);
    });

    it('MCP tool word-boundary matching', () => {
      // "open" should match "open" as a standalone word
      expect(isMutating('mcp__browser__open_page')).toBe(true);
      // "open" should NOT match inside another word (e.g., "openFile" is one word)
      expect(isMutating('mcp__filesystem__get_open_file_info')).toBe(true); // contains _open_
      expect(isMutating('mcp__browser__get_page_source')).toBe(false); // "open" not present
    });
  });

  describe('LoopGuard (unified)', () => {
    it('guardCount increments on tool suppression', () => {
      const guard = new LoopGuard({ tool: { enabled: true, windowSize: 6, threshold: 3, exemptTools: [] } });
      const call = { id: '1', name: 'session_stats', input: {} };
      guard.checkToolCalls([call]); // 1
      guard.checkToolCalls([call]); // 2
      expect(guard.guardCount).toBe(0);
      guard.checkToolCalls([call]); // 3 → suppressed → guardCount++
      expect(guard.guardCount).toBe(1);
    });

    it('guardCount increments on text loop', () => {
      const guard = new LoopGuard({ text: { enabled: true, windowSize: 6, threshold: 2, minLength: 30, similarity: 0.90 } });
      const text = 'The system is currently processing the request and analyzing the output data from the previous step.';
      guard.checkTextOutput(text); // streak 0
      guard.checkTextOutput(text); // streak 1
      expect(guard.guardCount).toBe(0);
      guard.checkTextOutput(text); // streak 2 → loop → guardCount++
      expect(guard.guardCount).toBe(1);
    });

    it('escalated returns true when guardCount reaches maxTriggers', () => {
      const guard = new LoopGuard({ tool: { enabled: true, windowSize: 6, threshold: 3, exemptTools: [] }, maxTriggers: 2 });
      // First suppression: 3 identical calls
      const call1 = { id: '1', name: 'x', input: {} };
      guard.checkToolCalls([call1]); guard.checkToolCalls([call1]); guard.checkToolCalls([call1]);
      expect(guard.guardCount).toBe(1);

      // Reset window → second suppression with different call
      guard.toolGuard.reset();
      const call2 = { id: '2', name: 'y', input: { a: 1 } };
      guard.checkToolCalls([call2]); guard.checkToolCalls([call2]); guard.checkToolCalls([call2]);
      expect(guard.guardCount).toBe(2);
      expect(guard.escalated).toBe(true);
    });

    it('reset clears guardCount', () => {
      const guard = new LoopGuard({ maxTriggers: 3 });
      const call = { id: '1', name: 'x', input: {} };
      guard.checkToolCalls([call]); guard.checkToolCalls([call]); guard.checkToolCalls([call]);
      expect(guard.guardCount).toBe(1);
      guard.reset();
      expect(guard.guardCount).toBe(0);
      expect(guard.escalated).toBe(false);
    });
  });
});
