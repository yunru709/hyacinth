/**
 * VoiceLibrary — 音色库（参考声音，TTS 输入侧）。
 *
 * 定位：数量少、低频变更的"资产目录"——参考音频文件 + JSON 索引
 * （人工可编辑、可随目录一起备份），不用 sqlite（量级不需要）。
 *
 * 结构：
 *   ~/.agent/companion/voices/            参考音频（3~10s 干净人声 wav/mp3）
 *   ~/.agent/companion/voices/voices.json 索引 [{id, file, desc, bind, createdAt}]
 *     - id       音色标识（companion_say.voice 用）
 *     - file     voices/ 目录下的文件名
 *     - bind     绑定的角色名（可选；角色默认音色）
 *
 * 索引放在 voices/ 内部（而非父目录）：
 *   - 整个 voices/ 目录可直接拷贝备份（索引与音频不分离）
 *   - 显式传入目录时（测试/多实例）完全隔离，不会串到共享的父目录
 * 旧实现曾把索引放在 voices/ 的父目录（~/.agent/companion/voices.json），
 * 读取时仍兼容该位置，写入一律落到新位置（自动迁移）。
 *
 * 解析链（companion_say.voice 省略时）：voice 参数 → 角色 bind → config 兜底。
 *
 * 管理入口：**只有协议层**（companion.voices / voiceRegister / voiceDelete /
 * voiceBind，即设置页）。参考音频是用户录的真人声音、删了不可重建，
 * 因此不提供 agent 工具 —— 模型只能"选用"音色，不能增删改。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('companion:voice-library');

export interface VoiceEntry {
  /** 音色标识（如 "rourou_main"） */
  id: string;
  /** voices/ 目录下的文件名（如 "柔柔_主.wav"） */
  file: string;
  /** 描述（可选） */
  desc?: string;
  /** 绑定的角色名（可选；作为该角色的默认音色） */
  bind?: string;
  createdAt: string;
}

const ALLOWED_EXT = new Set(['.wav', '.mp3']);

export class VoiceLibrary {
  private dir: string;
  private indexPath: string;
  /** 旧位置（voices/ 的父目录）；仅默认目录时启用，显式传目录时严格隔离 */
  private legacyIndexPath: string | null;

  constructor(voicesDir?: string) {
    const isDefault = !voicesDir;
    this.dir = voicesDir ?? path.join(os.homedir(), '.agent', 'companion', 'voices');
    this.indexPath = path.join(this.dir, 'voices.json');
    // 显式传目录时（测试/多实例）不回退旧位置 —— 否则索引会落到共享父目录（如 /tmp/voices.json），
    // 造成跨实例串数据（历史 bug：测试跑第二遍就"音色 id 已存在"）
    this.legacyIndexPath = isDefault ? path.join(path.dirname(this.dir), 'voices.json') : null;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get voicesDir(): string {
    return this.dir;
  }

  private static readEntries(p: string): VoiceEntry[] | null {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as VoiceEntry[];
      return Array.isArray(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  private readIndex(): VoiceEntry[] {
    // 优先目录内的新索引；不存在则回退旧位置（读到后下次写入自动落到新位置 = 迁移）
    const current = VoiceLibrary.readEntries(this.indexPath);
    if (current) return current;
    if (this.legacyIndexPath) {
      const legacy = VoiceLibrary.readEntries(this.legacyIndexPath);
      if (legacy) return legacy;
    }
    return [];
  }

  private writeIndex(entries: VoiceEntry[]): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(entries, null, 2), 'utf-8');
  }

  list(): VoiceEntry[] {
    return this.readIndex();
  }

  get(id: string): VoiceEntry | undefined {
    return this.readIndex().find((v) => v.id === id);
  }

  /** 音色文件绝对路径（不存在返回 undefined） */
  fileOf(entry: VoiceEntry): string | undefined {
    const abs = path.join(this.dir, entry.file);
    return fs.existsSync(abs) ? abs : undefined;
  }

  /** 音色文件字节数（文件缺失返回 0；voiceStats 用） */
  sizeOf(entry: VoiceEntry): number {
    const abs = this.fileOf(entry);
    if (!abs) return 0;
    try {
      return fs.statSync(abs).size;
    } catch {
      return 0;
    }
  }

  /**
   * 登记音色：srcPath 为待登记的音频（任意位置），复制进 voices/ 目录。
   * id 缺省 = 文件名去扩展名；重复 id 抛错。
   */
  register(srcPath: string, opts: { id?: string; desc?: string; bind?: string } = {}): VoiceEntry {
    if (!fs.existsSync(srcPath)) throw new Error(`参考音频不存在: ${srcPath}`);
    if (fs.statSync(srcPath).size < 1000) throw new Error('参考音频太小（<1KB），请提供 3~10 秒干净人声');
    const base = path.basename(srcPath);
    const ext = path.extname(base).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new Error(`不支持的音频格式 ${ext}（支持 wav/mp3）`);

    const entries = this.readIndex();
    const id = (opts.id || base.replace(ext, '')).trim();
    if (!id) throw new Error('音色 id 不能为空');
    if (entries.some((v) => v.id === id)) throw new Error(`音色 id 已存在: ${id}`);

    const fileName = id + ext;
    fs.copyFileSync(srcPath, path.join(this.dir, fileName));
    const entry: VoiceEntry = {
      id,
      file: fileName,
      ...(opts.desc ? { desc: opts.desc } : {}),
      ...(opts.bind ? { bind: opts.bind } : {}),
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
    this.writeIndex(entries);
    logger.info('voice registered', { id, file: fileName });
    return entry;
  }

  /** 绑定为角色默认音色（同角色先前绑定自动解除） */
  bind(id: string, character: string): VoiceEntry {
    const entries = this.readIndex();
    const entry = entries.find((v) => v.id === id);
    if (!entry) throw new Error(`音色不存在: ${id}`);
    for (const v of entries) {
      if (v.bind === character) delete v.bind;
    }
    entry.bind = character;
    this.writeIndex(entries);
    logger.info('voice bound', { id, character });
    return entry;
  }

  /** 删除音色（索引 + 文件；解除绑定） */
  delete(id: string): void {
    const entries = this.readIndex();
    const entry = entries.find((v) => v.id === id);
    if (!entry) return;
    const abs = path.join(this.dir, entry.file);
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (e) {
      logger.warn('voice file delete failed', { id, error: (e as Error).message });
    }
    this.writeIndex(entries.filter((v) => v.id !== id));
  }

  /** 解析角色默认音色（bind）；无绑定返回 undefined */
  resolveForCharacter(character: string): VoiceEntry | undefined {
    return this.readIndex().find((v) => v.bind === character && this.fileOf(v));
  }

  /** 解析 voice 引用为「绝对路径 + 条目」：条目 id / 文件名 / 绝对路径均可 */
  resolveRef(ref: string): { path: string; entry?: VoiceEntry } | undefined {
    const entry = this.get(ref);
    if (entry) {
      const p = this.fileOf(entry);
      if (p) return { path: p, entry };
    }
    const direct = path.isAbsolute(ref) ? ref : path.join(this.dir, ref);
    if (fs.existsSync(direct)) return { path: direct };
    if (fs.existsSync(ref)) return { path: ref };
    return undefined;
  }
}

let _instance: VoiceLibrary | null = null;

/** 全局实例（目录固定在 ~/.agent/companion/voices；测试用 new VoiceLibrary(dir)） */
export function getVoiceLibrary(): VoiceLibrary {
  if (!_instance) _instance = new VoiceLibrary();
  return _instance;
}
