// 生成语音库单测：落库/唯一键命中/幂等/list/prune（临时目录，零污染）
//
// 覆盖重点：
//  - 唯一键 (character, text_hash, emotion_key, voice_id) 的命中与幂等
//  - **不同角色 / 不同音色说同一句台词必须各自入库**（id 需覆盖完整唯一键，
//    否则撞 PRIMARY KEY；历史 bug：id 只由 textHash+emotion 生成）
//  - prune 保留最近 N 条（条目 + 音频文件一并删除）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeneratedVoiceStore } from './voice-store.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvs-'));
  return { store: new GeneratedVoiceStore(dir), dir };
}

/** 造一个"够大"的假 wav（insert 不校验内容，仅收纳文件） */
function makeWav(dir: string, name: string, size = 4096): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([Buffer.from('RIFF0000WAVEfmt '), Buffer.alloc(size)]));
  return p;
}

const SRC = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gvsrc-'));

const BASE = { provider: 'indextts', format: 'wav', byteSize: 4096 } as const;

describe('GeneratedVoiceStore 生成语音库', () => {
  it('insert：落库 + 音频文件收纳进角色目录', () => {
    const { store, dir } = makeStore();
    const row = store.insert(makeWav(SRC(), 'a.wav'), {
      ...BASE,
      character: '柔柔',
      textNorm: '你回来啦',
      textHash: 'h1',
      emotionKey: 'happy',
      voiceId: 'v1',
    });

    expect(row.character).toBe('柔柔');
    expect(row.textNorm).toBe('你回来啦');
    expect(row.emotionKey).toBe('happy');
    expect(row.voiceId).toBe('v1');
    // 音频文件按角色分目录收纳，且真实存在
    expect(row.relPath.startsWith('柔柔/')).toBe(true);
    expect(fs.existsSync(store.filePathOf(row))).toBe(true);
    expect(store.filePathOf(row).startsWith(dir)).toBe(true);
  });

  it('find：唯一键命中（缓存秒回）', () => {
    const { store } = makeStore();
    store.insert(makeWav(SRC(), 'a.wav'), {
      ...BASE, character: '柔柔', textNorm: '你好', textHash: 'h2', emotionKey: '', voiceId: 'v1',
    });
    const hit = store.find('柔柔', 'h2', '', 'v1');
    expect(hit).toBeTruthy();
    expect(hit!.textNorm).toBe('你好');
    // 情绪/音色不同 → 不命中（唯一键的四要素都要对上）
    expect(store.find('柔柔', 'h2', 'sad', 'v1')).toBeUndefined();
    expect(store.find('柔柔', 'h2', '', 'v2')).toBeUndefined();
    expect(store.find('小蝶', 'h2', '', 'v1')).toBeUndefined();
  });

  it('insert 幂等：同唯一键重复插入返回同一条，不重复写文件', () => {
    const { store } = makeStore();
    const e = { ...BASE, character: '柔柔', textNorm: '又见面了', textHash: 'h3', emotionKey: '', voiceId: 'v1' };
    const first = store.insert(makeWav(SRC(), 'a.wav'), e);
    const again = store.insert(makeWav(SRC(), 'b.wav'), e);

    expect(again.id).toBe(first.id);
    expect(store.listByCharacter('柔柔')).toHaveLength(1);
  });

  it('不同 voiceId 同台词 → 各自入库（换音色重新合成）', () => {
    const { store } = makeStore();
    const a = store.insert(makeWav(SRC(), 'a.wav'), {
      ...BASE, character: '柔柔', textNorm: '同一句', textHash: 'h4', emotionKey: '', voiceId: 'v1',
    });
    const b = store.insert(makeWav(SRC(), 'b.wav'), {
      ...BASE, character: '柔柔', textNorm: '同一句', textHash: 'h4', emotionKey: '', voiceId: 'v2',
    });

    expect(a.id).not.toBe(b.id); // id 必须区分音色，否则撞 PRIMARY KEY
    expect(store.listByCharacter('柔柔')).toHaveLength(2);
    expect(store.find('柔柔', 'h4', '', 'v2')?.id).toBe(b.id);
  });

  it('不同 character 同台词 → 各自入库（角色间不串）', () => {
    const { store } = makeStore();
    const a = store.insert(makeWav(SRC(), 'a.wav'), {
      ...BASE, character: '柔柔', textNorm: '你好呀', textHash: 'h5', emotionKey: '', voiceId: 'v1',
    });
    const b = store.insert(makeWav(SRC(), 'b.wav'), {
      ...BASE, character: '小蝶', textNorm: '你好呀', textHash: 'h5', emotionKey: '', voiceId: 'v1',
    });

    expect(a.id).not.toBe(b.id); // id 必须区分角色
    expect(store.listByCharacter('柔柔')).toHaveLength(1);
    expect(store.listByCharacter('小蝶')).toHaveLength(1);
  });

  it('listByCharacter：按角色隔离 + limit 生效 + 倒序', () => {
    const { store } = makeStore();
    // 柔柔 3 条（时间戳拉开，保证倒序可判定）
    for (const [i, hash] of ['ha', 'hb', 'hc'].entries()) {
      store.insert(makeWav(SRC(), `a${i}.wav`), {
        ...BASE, character: '柔柔', textNorm: `第${i}句`, textHash: hash, voiceId: 'v1',
      });
      const until = Date.now() + 5;
      while (Date.now() < until) { /* 拉开 createdAt，保证排序稳定 */ }
    }
    // 小蝶 1 条（不应串进柔柔的列表）
    store.insert(makeWav(SRC(), 'x.wav'), {
      ...BASE, character: '小蝶', textNorm: '别的角色', textHash: 'hx', voiceId: 'v1',
    });

    expect(store.listByCharacter('柔柔')).toHaveLength(3);
    expect(store.listByCharacter('柔柔', 2)).toHaveLength(2);
    expect(store.listByCharacter('小蝶')).toHaveLength(1);
    // 倒序：最新插入的排最前
    expect(store.listByCharacter('柔柔')[0].textNorm).toBe('第2句');
  });

  it('prune：保留最近 N 条，条目与音频文件一并删除', () => {
    const { store } = makeStore();
    const paths: string[] = [];
    for (const [i, hash] of ['p1', 'p2', 'p3', 'p4'].entries()) {
      const row = store.insert(makeWav(SRC(), `p${i}.wav`), {
        ...BASE, character: '柔柔', textNorm: `旧句${i}`, textHash: hash, voiceId: 'v1',
      });
      paths.push(store.filePathOf(row));
      const until = Date.now() + 5;
      while (Date.now() < until) { /* 拉开 createdAt */ }
    }
    // 插入顺序 p1→p4，倒序后 p4 最新；保留 2 条 = 删掉最早的 2 条（p1/p2）
    const removed = store.prune('柔柔', 2);

    expect(removed).toBe(2);
    expect(store.listByCharacter('柔柔')).toHaveLength(2);
    // 被删的两条文件也不在磁盘上
    expect(paths.filter((p) => fs.existsSync(p))).toHaveLength(2);
    // 其他角色不受影响
    expect(store.prune('小蝶', 2)).toBe(0);
  });

  it('prune：数量未超阈值时不删任何条目', () => {
    const { store } = makeStore();
    store.insert(makeWav(SRC(), 'a.wav'), {
      ...BASE, character: '柔柔', textNorm: '只有一句', textHash: 'q1', voiceId: 'v1',
    });
    expect(store.prune('柔柔', 10)).toBe(0);
    expect(store.listByCharacter('柔柔')).toHaveLength(1);
  });
});
