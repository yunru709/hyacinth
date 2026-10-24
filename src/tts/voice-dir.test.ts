// voice-dir 单测：目录解析（跟随 models.root）、成对过滤、旧位置迁移（幂等/不覆盖）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  voicesDir,
  listVoiceEntries,
  migrateLegacyVoices,
  ensureVoicesReady,
  __resetVoicesMigrationForTest,
  DEFAULT_VOICE_ID,
} from './voice-dir.js';

const ORIG_ENV = process.env.HYACINTH_MODELS_DIR;
let tmp = '';

/** 造一对参考音（内容无关，只用存在性） */
function putPair(dir: string, id: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.wav`), 'wav');
  fs.writeFileSync(path.join(dir, `${id}.txt`), '文字稿');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-voices-'));
  process.env.HYACINTH_MODELS_DIR = tmp;
  __resetVoicesMigrationForTest();
});

afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.HYACINTH_MODELS_DIR;
  else process.env.HYACINTH_MODELS_DIR = ORIG_ENV;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('voicesDir', () => {
  it('跟随 models.root（HYACINTH_MODELS_DIR）：<root>/voices，与模型权重目录解耦', () => {
    expect(voicesDir()).toBe(path.join(tmp, 'voices'));
    // 不在 tts/cosyvoice3 之下 —— 删模型不会连带删参考音
    expect(voicesDir()).not.toContain(path.join('tts', 'cosyvoice3'));
  });
});

describe('listVoiceEntries', () => {
  it('只列成对的音色；落单 wav 不列；default 排首位', () => {
    const dir = voicesDir();
    putPair(dir, 'narrator');
    putPair(dir, DEFAULT_VOICE_ID);
    fs.writeFileSync(path.join(dir, 'orphan.wav'), 'wav');   // 无 txt
    const ids = listVoiceEntries().map((e) => e.id);
    expect(ids).toEqual([DEFAULT_VOICE_ID, 'narrator']);
  });

  it('目录不存在 → 空数组（不抛错）', () => {
    expect(listVoiceEntries(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('migrateLegacyVoices', () => {
  it('旧位置两类都搬到新目录：prompt.* → default.*，prompts/<id>.* → <id>.*', () => {
    const modelDir = path.join(tmp, 'tts', 'cosyvoice3');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'prompt.wav'), 'wav');
    fs.writeFileSync(path.join(modelDir, 'prompt.txt'), '稿');
    putPair(path.join(modelDir, 'prompts'), 'narrator');

    const r = migrateLegacyVoices(modelDir);
    expect(r.moved.sort()).toEqual([DEFAULT_VOICE_ID, 'narrator'].sort());
    expect(r.kept).toEqual([]);
    // 新位置可列
    expect(listVoiceEntries().map((e) => e.id)).toEqual([DEFAULT_VOICE_ID, 'narrator']);
    // 源文件已删（只留一份）
    expect(fs.existsSync(path.join(modelDir, 'prompt.wav'))).toBe(false);
    expect(fs.existsSync(path.join(modelDir, 'prompts', 'narrator.wav'))).toBe(false);
  });

  it('幂等：再跑一次不搬任何东西（源已空）', () => {
    const modelDir = path.join(tmp, 'tts', 'cosyvoice3');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'prompt.wav'), 'wav');
    fs.writeFileSync(path.join(modelDir, 'prompt.txt'), '稿');
    migrateLegacyVoices(modelDir);
    const second = migrateLegacyVoices(modelDir);
    expect(second).toEqual({ moved: [], kept: [] });
  });

  it('不覆盖：新位置已有同 id → 计入 kept，旧文件保留原处', () => {
    const dir = voicesDir();
    putPair(dir, DEFAULT_VOICE_ID);
    fs.writeFileSync(path.join(dir, `${DEFAULT_VOICE_ID}.wav`), 'NEW');
    const modelDir = path.join(tmp, 'tts', 'cosyvoice3');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'prompt.wav'), 'OLD');
    fs.writeFileSync(path.join(modelDir, 'prompt.txt'), 'OLD');

    const r = migrateLegacyVoices(modelDir);
    expect(r.moved).toEqual([]);
    expect(r.kept).toEqual([DEFAULT_VOICE_ID]);
    // 新位置内容未被覆盖；旧文件仍在
    expect(fs.readFileSync(path.join(dir, `${DEFAULT_VOICE_ID}.wav`), 'utf8')).toBe('NEW');
    expect(fs.existsSync(path.join(modelDir, 'prompt.wav'))).toBe(true);
  });

  it('不成对的旧文件不搬（列不出来就不迁移）', () => {
    const modelDir = path.join(tmp, 'tts', 'cosyvoice3', 'prompts');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'lone.wav'), 'wav');
    const r = migrateLegacyVoices(path.join(tmp, 'tts', 'cosyvoice3'));
    expect(r).toEqual({ moved: [], kept: [] });
    expect(fs.existsSync(path.join(modelDir, 'lone.wav'))).toBe(true);   // 原地不动
  });
});

describe('ensureVoicesReady', () => {
  it('进程内只迁移一次（第二次返回 null）', () => {
    const modelDir = path.join(tmp, 'tts', 'cosyvoice3');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'prompt.wav'), 'wav');
    fs.writeFileSync(path.join(modelDir, 'prompt.txt'), '稿');
    expect(ensureVoicesReady(modelDir)?.moved).toEqual([DEFAULT_VOICE_ID]);
    expect(ensureVoicesReady(modelDir)).toBeNull();
  });
});
