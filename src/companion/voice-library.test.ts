// 音色库单测：登记/列表/绑定/解析链（临时目录，零污染）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoiceLibrary } from './voice-library.js';

function makeLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  return new VoiceLibrary(dir);
}

function makeWav(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([Buffer.from('RIFF0000WAVEfmt '), Buffer.alloc(2048)]));
  return p;
}

describe('VoiceLibrary 音色库', () => {
  it('register：复制文件进库目录 + 索引；重复 id 报错', () => {
    const lib = makeLib();
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vls-'));
    const src = makeWav(srcDir, 'rourou.wav');
    const entry = lib.register(src, { id: 'rourou_main', desc: '柔柔默认' });

    expect(entry.id).toBe('rourou_main');
    expect(lib.list()).toHaveLength(1);
    expect(lib.get('rourou_main')).toBeTruthy();
    expect(fs.existsSync(path.join(lib.voicesDir, 'rourou_main.wav'))).toBe(true);
    expect(() => lib.register(src, { id: 'rourou_main' })).toThrow(/已存在/);
  });

  it('bind：角色绑定互斥（同角色旧绑定自动解除）+ resolveForCharacter', () => {
    const lib = makeLib();
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'vls-'));
    lib.register(makeWav(sd, 'a.wav'), { id: 'va' });
    lib.register(makeWav(sd, 'b.wav'), { id: 'vb' });

    lib.bind('va', '小蝶');
    expect(lib.resolveForCharacter('小蝶')?.id).toBe('va');
    lib.bind('vb', '小蝶');
    expect(lib.resolveForCharacter('小蝶')?.id).toBe('vb');
    expect(lib.get('va')?.bind).toBeUndefined(); // 旧绑定自动解除
  });

  it('resolveRef：id / 文件名 / 绝对路径 三种引用都能解析', () => {
    const lib = makeLib();
    lib.register(makeWav(fs.mkdtempSync(path.join(os.tmpdir(), 'vls-')), 'xiaodie.wav'), { id: 'xiaodie' });

    expect(lib.resolveRef('xiaodie')?.path).toContain('xiaodie.wav');
    expect(lib.resolveRef('xiaodie.wav')?.path).toContain('xiaodie.wav');
    const abs = path.join(lib.voicesDir, 'xiaodie.wav');
    expect(lib.resolveRef(abs)?.path).toBe(abs);
    expect(lib.resolveRef('不存在')).toBeUndefined();
  });

  it('delete：索引与文件一并移除', () => {
    const lib = makeLib();
    lib.register(makeWav(fs.mkdtempSync(path.join(os.tmpdir(), 'vls-')), 'gone.wav'), { id: 'gone' });
    lib.delete('gone');
    expect(lib.get('gone')).toBeUndefined();
    expect(fs.existsSync(path.join(lib.voicesDir, 'gone.wav'))).toBe(false);
  });

  it('register 非音频扩展名报错', () => {
    const lib = makeLib();
    const txt = makeWav(fs.mkdtempSync(path.join(os.tmpdir(), 'vls-')), 'x.txt');
    expect(() => lib.register(txt, { id: 'x' })).toThrow(/不支持的音频格式/);
  });
});
