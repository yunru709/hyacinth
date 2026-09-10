// 陪伴语音服务单测：容量治理（落库后按角色保留最近 N 条）
//
// 覆盖重点：
//  - 超出 keepPerCharacter 时，条目与音频文件一并清理，保留最近的
//  - keepPerCharacter = 0 不清理；未指定时用 DEFAULT_KEEP_PER_CHARACTER
//  - 缓存命中不落库、不触发清理（命中即复用，不烧 TTS）
//
// 注：生成语音是缓存而非资产（台词文本仍在，删了可重造），所以库必须有上限。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { GeneratedArtifact } from '../generation/interface.js';
import type { GenerationRegistry, GenerationService } from '../generation/index.js';
import type { CompanionVoiceEvent } from '../events.js';
import {
  CompanionVoiceService,
  DEFAULT_KEEP_PER_CHARACTER,
  type CompanionTtsConfig,
} from './voice.js';
import { GeneratedVoiceStore } from './voice-store.js';

function makeDeps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-'));
  const store = new GeneratedVoiceStore(path.join(root, 'generated'));
  let n = 0;
  // fake 生成服务：产出一个新 wav，不真跑 TTS
  const service = {
    generate: async () => {
      const p = path.join(root, `out-${n++}.wav`);
      fs.writeFileSync(p, Buffer.concat([Buffer.from('RIFF0000WAVEfmt '), Buffer.alloc(2048)]));
      return {
        localPath: p,
        sourceUrl: '',
        mediaType: 'audio/wav',
        byteSize: 2048,
        provider: 'fake',
        model: 'fake-1',
      } as GeneratedArtifact;
    },
  } as unknown as GenerationService;
  const registry = {
    getDefaultProviderName: () => 'fake',
  } as unknown as GenerationRegistry;
  return { store, service, registry, root };
}

/**
 * 串行合成一句，等这一句真正结束（含 busy 复位）再返回。
 *
 * 两个坑：
 *  1. onTurnEnd 是 fire-and-forget，notify 在 busy 复位**之前**触发 ——
 *     不额外让出事件循环就发下一句，会被判定为"忙时排队"而静默丢弃
 *     （设计如此：旧台词不补播，只保留最新一条）。
 *  2. 因此这里用 setTimeout(0) 让出宏任务，确保 synthesizeLoop 的
 *     finally（busy = false）已执行。
 */
function synthOnce(
  svc: CompanionVoiceService,
  text: string,
  character: string,
  cfg: CompanionTtsConfig,
): Promise<{ state: string; cached?: boolean }> {
  return new Promise((resolve) => {
    svc.onTurnEnd(text, character, (_type, payload) => {
      const p = payload as { state?: string; cached?: boolean } | undefined;
      if (!p?.state) return;
      setTimeout(() => resolve({ state: p.state as string, cached: p.cached }), 0);
    }, cfg);
  });
}

describe('CompanionVoiceService 容量治理', () => {
  it('落库后按角色保留最近 N 条（条目与音频文件一并清理）', async () => {
    const { store, service, registry } = makeDeps();
    const svc = new CompanionVoiceService({ registry, service, store, cwd: process.cwd() });

    for (const t of ['第一句', '第二句', '第三句', '第四句', '第五句']) {
      const r = await synthOnce(svc, t, '柔柔', { enabled: true, keepPerCharacter: 3 });
      expect(r.state).toBe('ready');
    }

    const texts = store.listByCharacter('柔柔').map((r) => r.textNorm);
    expect(texts).toHaveLength(3);
    // 保留最近的：前两句被清理
    expect(texts).not.toContain('第一句');
    expect(texts).not.toContain('第二句');
    expect(texts).toContain('第三句');
    expect(texts).toContain('第四句');
    expect(texts).toContain('第五句');
    // 留下的条目，音频文件都还在（被清理的文件已删除）
    expect(store.listByCharacter('柔柔').every((r) => fs.existsSync(store.filePathOf(r)))).toBe(true);
  });

  it('清理只作用于当前角色（其他角色不受影响）', async () => {
    const { store, service, registry } = makeDeps();
    const svc = new CompanionVoiceService({ registry, service, store, cwd: process.cwd() });

    for (const t of ['柔1', '柔2', '柔3', '柔4']) {
      await synthOnce(svc, t, '柔柔', { enabled: true, keepPerCharacter: 2 });
    }
    for (const t of ['蝶1', '蝶2']) {
      await synthOnce(svc, t, '小蝶', { enabled: true, keepPerCharacter: 2 });
    }

    expect(store.listByCharacter('柔柔')).toHaveLength(2); // 4 → 保留 2
    expect(store.listByCharacter('小蝶')).toHaveLength(2); // 未超限，全留
  });

  it('keepPerCharacter = 0 → 不清理', async () => {
    const { store, service, registry } = makeDeps();
    const svc = new CompanionVoiceService({ registry, service, store, cwd: process.cwd() });

    for (const t of ['第一句', '第二句', '第三句']) {
      await synthOnce(svc, t, '柔柔', { enabled: true, keepPerCharacter: 0 });
    }

    expect(store.listByCharacter('柔柔')).toHaveLength(3);
  });

  it('未指定 keepPerCharacter → 用默认值，小样本不受影响', async () => {
    const { store, service, registry } = makeDeps();
    const svc = new CompanionVoiceService({ registry, service, store, cwd: process.cwd() });
    expect(DEFAULT_KEEP_PER_CHARACTER).toBeGreaterThan(0);

    for (const t of ['第一句', '第二句', '第三句']) {
      await synthOnce(svc, t, '柔柔', { enabled: true });
    }

    expect(store.listByCharacter('柔柔')).toHaveLength(3);
  });

  it('缓存命中不落库、不触发清理（命中即复用）', async () => {
    const { store, service, registry } = makeDeps();
    const svc = new CompanionVoiceService({ registry, service, store, cwd: process.cwd() });

    for (const t of ['第一句', '第二句', '第三句']) {
      await synthOnce(svc, t, '柔柔', { enabled: true, keepPerCharacter: 3 });
    }
    expect(store.listByCharacter('柔柔')).toHaveLength(3);

    // 再说一次第一句 → 命中缓存（不新增条目、不触发清理）
    const again = await synthOnce(svc, '第一句', '柔柔', { enabled: true, keepPerCharacter: 3 });
    expect(again.state).toBe('ready');
    expect(again.cached).toBe(true);
    expect(store.listByCharacter('柔柔')).toHaveLength(3);
  });

  it('sayId 透传：overrides 带 sayId → companion.voice 事件原样带回', async () => {
    const { store, service, registry } = makeDeps();
    const svc = new CompanionVoiceService({ registry, service, store, cwd: process.cwd() });

    // 时序守卫依赖：companion.say 与 companion.voice 靠 sayId 关联，
    // 前端比对 sayId 丢弃过期语音（TTS 异步合成，文字早已上屏、语音迟到）
    let captured: CompanionVoiceEvent | undefined;
    await new Promise<void>((resolve) => {
      svc.onTurnEnd('时序测试句', '柔柔', (_type, payload) => {
        captured = payload;
        if (payload?.state) resolve();
      }, { enabled: true }, { sayId: 'say_test_1' });
    });

    expect(captured?.state).toBe('ready');
    expect(captured?.sayId).toBe('say_test_1');
  });
});
