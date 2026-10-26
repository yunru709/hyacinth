// voice-dir 单测：目录解析（跟随 models.root）、成对过滤、旧位置迁移（幂等/不覆盖）。
// 2026-10-26 起增加「角色/情绪」两级结构：listVoiceRoles 去重、resolveVoice 情绪回退链、
// 目录优先于同名扁平文件、WAV 头解析与参考音质检。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  voicesDir,
  listVoiceEntries,
  listVoiceRoles,
  resolveVoice,
  inspectWav,
  inspectVoiceQuality,
  migrateLegacyVoices,
  ensureVoicesReady,
  __resetVoicesMigrationForTest,
  DEFAULT_VOICE_ID,
  DEFAULT_EMOTION,
} from './voice-dir.js';

const ORIG_ENV = process.env.HYACINTH_MODELS_DIR;
let tmp = '';

/** 造一对参考音（内容无关，只用存在性） */
function putPair(dir: string, id: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.wav`), 'wav');
  fs.writeFileSync(path.join(dir, `${id}.txt`), '文字稿');
}

/** 造「角色/情绪」结构的一份参考音 */
function putEmotion(dir: string, role: string, emotion: string, txt = '文字稿'): void {
  const roleDir = path.join(dir, role);
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, `${emotion}.wav`), 'wav');
  fs.writeFileSync(path.join(roleDir, `${emotion}.txt`), txt);
}

/**
 * 造一个格式合法的 WAV（只写头 + 静音 data，够 inspectWav 解析）。
 * float32 用 audioFormat=3，整型用 1 —— 两者 fmt 布局一致，只有 format 字段不同。
 */
function makeWav(
  file: string,
  opts: { sampleRate: number; channels: number; bits: number; seconds: number; float?: boolean },
): void {
  const { sampleRate, channels, bits, seconds, float } = opts;
  const bytesPerSample = bits / 8;
  const dataSize = Math.round(sampleRate * channels * bytesPerSample * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(float ? 3 : 1, 20); // audioFormat
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byteRate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // blockAlign
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
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
    fs.writeFileSync(path.join(dir, 'orphan.wav'), 'wav'); // 无 txt
    const ids = listVoiceEntries().map((e) => e.id);
    expect(ids).toEqual([DEFAULT_VOICE_ID, 'narrator']);
  });

  it('目录不存在 → 空数组（不抛错）', () => {
    expect(listVoiceEntries(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('两级结构：<角色>/<情绪>.wav 全部列出，旧扁平文件等价 neutral', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'neutral');
    putEmotion(dir, '柔柔', 'happy');
    putPair(dir, 'legacy');
    const got = listVoiceEntries().map((e) => `${e.id}/${e.emotion}`);
    expect(got).toEqual(['legacy/neutral', '柔柔/neutral', '柔柔/happy']);
  });

  it('落单的情绪 wav（无 txt）不列', () => {
    const dir = voicesDir();
    const roleDir = path.join(dir, '柔柔');
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(path.join(roleDir, 'sad.wav'), 'wav'); // 无 sad.txt
    expect(listVoiceEntries()).toEqual([]);
  });

  it('⚠️ 同名目录优先于扁平文件：两者并存时只认目录，不出现两条 neutral', () => {
    const dir = voicesDir();
    putPair(dir, '柔柔'); // 旧扁平 柔柔.wav（neutral）
    putEmotion(dir, '柔柔', 'neutral'); // 新目录 柔柔/neutral.wav
    const got = listVoiceEntries();
    expect(got).toHaveLength(1);
    expect(got[0].wavPath).toContain(path.join('柔柔', 'neutral.wav'));
  });
});

describe('listVoiceRoles', () => {
  it('按角色去重；情绪列表 neutral 优先', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'happy');
    putEmotion(dir, '柔柔', 'neutral');
    putEmotion(dir, '柔柔', 'sad');
    putPair(dir, 'narrator');
    const roles = listVoiceRoles();
    expect(roles.map((r) => r.id)).toEqual(['narrator', '柔柔']);
    expect(roles[1].emotions).toEqual(['neutral', 'happy', 'sad']);
  });
});

describe('resolveVoice（情绪回退链）', () => {
  it('精确命中：要 happy 且有 happy → 直接用，不标记回退', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'neutral');
    putEmotion(dir, '柔柔', 'happy');
    const r = resolveVoice('柔柔', 'happy');
    expect(r?.resolved).toBe('happy');
    expect(r?.fellBack).toBe(false);
  });

  it('就近回退：要 excited 但没有 → 退到 happy（同语义簇），标记回退', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'happy');
    putEmotion(dir, '柔柔', 'neutral');
    const r = resolveVoice('柔柔', 'excited');
    expect(r?.resolved).toBe('happy');
    expect(r?.fellBack).toBe(true);
    expect(r?.requested).toBe('excited');
  });

  it('二级回退：要 shy 且只有 neutral → 收敛到 neutral', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'neutral');
    const r = resolveVoice('柔柔', 'shy');
    expect(r?.resolved).toBe('neutral');
    expect(r?.fellBack).toBe(true);
  });

  it('词表外情绪：不报错，退到 neutral', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'neutral');
    const r = resolveVoice('柔柔', '莫名其妙的情绪');
    expect(r?.resolved).toBe('neutral');
    expect(r?.fellBack).toBe(true);
  });

  it('不传 emotion → 用 neutral，不标记回退', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'neutral');
    const r = resolveVoice('柔柔');
    expect(r?.resolved).toBe(DEFAULT_EMOTION);
    expect(r?.fellBack).toBe(false);
  });

  it('角色一份参考音都没有 → null（调用方回退内置音色）', () => {
    expect(resolveVoice('不存在')).toBeNull();
  });

  it('该角色只有非 neutral 情绪、请求的词表外 → 退回它第一份（总比哑掉强）', () => {
    const dir = voicesDir();
    putEmotion(dir, '柔柔', 'angry');
    const r = resolveVoice('柔柔', 'xyz');
    expect(r?.resolved).toBe('angry');
    expect(r?.fellBack).toBe(true);
  });

  it('旧扁平文件参与回退：只有 柔柔.wav 时，任何情绪都解析到它（neutral）', () => {
    const dir = voicesDir();
    putPair(dir, '柔柔');
    const r = resolveVoice('柔柔', 'happy');
    expect(r?.resolved).toBe(DEFAULT_EMOTION);
    expect(r?.entry.wavPath).toContain('柔柔.wav');
  });
});

describe('inspectWav', () => {
  it('PCM 24k 单声道 16bit：频率/声道/时长正确', () => {
    const f = path.join(tmp, 'a.wav');
    makeWav(f, { sampleRate: 24000, channels: 1, bits: 16, seconds: 3 });
    const info = inspectWav(f);
    expect(info?.sampleRate).toBe(24000);
    expect(info?.channels).toBe(1);
    expect(info?.durationSec).toBeCloseTo(3, 1);
  });

  it('float32 也能解析（audioFormat=3，布局与整型一致）', () => {
    const f = path.join(tmp, 'b.wav');
    makeWav(f, { sampleRate: 44100, channels: 2, bits: 32, seconds: 2, float: true });
    const info = inspectWav(f);
    expect(info?.sampleRate).toBe(44100);
    expect(info?.channels).toBe(2);
    expect(info?.durationSec).toBeCloseTo(2, 1);
  });

  it('非 WAV → null（不抛错）', () => {
    const f = path.join(tmp, 'c.wav');
    fs.writeFileSync(f, 'not a wav at all');
    expect(inspectWav(f)).toBeNull();
  });

  it('文件不存在 → null', () => {
    expect(inspectWav(path.join(tmp, 'missing.wav'))).toBeNull();
  });
});

describe('inspectVoiceQuality', () => {
  it('合格样本：24k/单声道/5s/有文字稿 → ok，无警告', () => {
    const dir = voicesDir();
    const roleDir = path.join(dir, '柔柔');
    makeWav(path.join(roleDir, 'neutral.wav'), { sampleRate: 24000, channels: 1, bits: 16, seconds: 5 });
    fs.writeFileSync(path.join(roleDir, 'neutral.txt'), '这是一段文字稿');
    const entry = listVoiceEntries().find((e) => e.id === '柔柔')!;
    const q = inspectVoiceQuality(entry);
    expect(q.ok).toBe(true);
    expect(q.warnings).toEqual([]);
  });

  it('过长（15.9s）→ 警告偏长（实测过长会拖慢合成）', () => {
    const dir = voicesDir();
    const roleDir = path.join(dir, '柔柔');
    makeWav(path.join(roleDir, 'neutral.wav'), { sampleRate: 24000, channels: 1, bits: 16, seconds: 15.9 });
    fs.writeFileSync(path.join(roleDir, 'neutral.txt'), '稿');
    const q = inspectVoiceQuality(listVoiceEntries()[0]);
    expect(q.ok).toBe(false);
    expect(q.warnings.join()).toContain('偏长');
  });

  it('立体声 + 低采样率 → 两条警告', () => {
    const dir = voicesDir();
    const roleDir = path.join(dir, '柔柔');
    makeWav(path.join(roleDir, 'neutral.wav'), { sampleRate: 8000, channels: 2, bits: 16, seconds: 4 });
    fs.writeFileSync(path.join(roleDir, 'neutral.txt'), '稿');
    const q = inspectVoiceQuality(listVoiceEntries()[0]);
    expect(q.warnings.join()).toContain('立体声');
    expect(q.warnings.join()).toContain('采样率偏低');
  });

  it('文字稿为空 → 警告（克隆必失败）', () => {
    const dir = voicesDir();
    const roleDir = path.join(dir, '柔柔');
    makeWav(path.join(roleDir, 'neutral.wav'), { sampleRate: 24000, channels: 1, bits: 16, seconds: 5 });
    fs.writeFileSync(path.join(roleDir, 'neutral.txt'), '   ');
    const q = inspectVoiceQuality(listVoiceEntries()[0]);
    expect(q.warnings.join()).toContain('文字稿为空');
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

  it('成对的旧文件不搬（列不出来就不迁移）', () => {
    const modelDir = path.join(tmp, 'tts', 'cosyvoice3', 'prompts');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'lone.wav'), 'wav');
    const r = migrateLegacyVoices(path.join(tmp, 'tts', 'cosyvoice3'));
    expect(r).toEqual({ moved: [], kept: [] });
    expect(fs.existsSync(path.join(modelDir, 'lone.wav'))).toBe(true); // 原地不动
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
