/**
 * 语音参考音目录 —— 按「角色 / 情绪」两级组织，并向后兼容旧的扁平结构。
 *
 * 【为什么这么改】（2026-10-26 孑遗定调）
 *   同一角色会有多份**不同情绪**的参考音，say 说不同情绪的话时应该用对应那份。
 *   旧的扁平 `<id>.wav` 无法表达"同一个人、不同情绪"，只能一个角色一份。
 *
 * 目录约定：
 *   <models.root>/voices/<角色>/<情绪>.wav + <情绪>.txt    ← 首选
 *   <models.root>/voices/<角色>.wav    + <角色>.txt        ← 旧扁平，等价 neutral（继续识别）
 *
 * 解析链（say(voice=角色, emotion=happy)）：
 *   角色/happy →（缺失）按近似链退 → 角色/neutral →（缺失）旧扁平 角色 →（缺失）内置音色
 *
 * 【位置为什么仍在 models.root 下、但不在模型产物目录内】
 *   参考音是**用户录的素材（不可再生）**，模型目录是可重建的下载缓存。
 *   放一起 ⇒ 清理重下模型时参考音被一并删掉（历史事故）。
 *
 * 音色对约定：wav = 声音样本（建议 3~10s，≥16kHz），txt = 该样本的逐字文字稿。
 * 只有成对的才进列表 —— 落单的视为未完成（克隆时必须成对，列出来点了必失败）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getModelRoot } from '../runtime/model-root.js';

/** 参考音目录（跟随 models.root；与模型权重目录解耦） */
export function voicesDir(): string {
  return path.join(getModelRoot(), 'voices');
}

/** 默认角色的 id（空 voice 参数时使用；也是零样本回退角色） */
export const DEFAULT_VOICE_ID = 'default';

/** 中性情绪 —— 所有角色的兜底，也是旧扁平文件的等价情绪 */
export const DEFAULT_EMOTION = 'neutral';

/**
 * 情绪近似链：请求的情绪没有对应参考音时，按这个顺序退。
 *
 * 设计原则：**先退同一语义簇，再退中性，最后才放弃**。
 *   · happy ↔ excited ↔ playful 属"高唤起正面"，互相替代听感可接受
 *   · sad ↔ tender ↔ shy 属"低唤起柔和"，同理
 *   · angry ↔ serious 属"高唤起负面"
 *   · 任何链最终收敛到 neutral，保证一定有着落
 *
 * 未登记的情绪词**不报错**，直接按 [该词, neutral] 处理 —— 语音是交付增强，
 * 不能因为模型写了个词表外的词就让整句哑掉（同 say 工具的其他设计取舍）。
 */
export const EMOTION_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  neutral: ['neutral'],
  calm: ['calm', 'neutral'],
  happy: ['happy', 'excited', 'playful', 'neutral'],
  excited: ['excited', 'happy', 'playful', 'neutral'],
  playful: ['playful', 'happy', 'excited', 'neutral'],
  sad: ['sad', 'tender', 'neutral'],
  tender: ['tender', 'calm', 'sad', 'neutral'],
  shy: ['shy', 'tender', 'calm', 'neutral'],
  angry: ['angry', 'serious', 'neutral'],
  serious: ['serious', 'calm', 'neutral'],
};

/** 一条可用参考音（wav + txt 成对存在） */
export interface VoiceEntry {
  /** 角色 id（= 二级目录名，或旧扁平文件名） */
  id: string;
  /** 情绪 key；旧扁平文件固定为 DEFAULT_EMOTION */
  emotion: string;
  wavPath: string;
  txtPath: string;
}

/** 拼接角色目录下某情绪的候选路径（不做存在性判断） */
function emotionPaths(roleDir: string, emotion: string): { wavPath: string; txtPath: string } {
  return {
    wavPath: path.join(roleDir, `${emotion}.wav`),
    txtPath: path.join(roleDir, `${emotion}.txt`),
  };
}

/**
 * 角色/情绪 key 的比较：**按 UTF-16 code unit 稳定排序，不用 localeCompare**。
 *
 * 【为什么不用 localeCompare】（2026-10-26 实测翻车）
 *   localeCompare 对「中文 vs 拉丁」混排的结果依赖运行环境的 ICU locale 数据 ——
 *   同一份目录在不同机器/不同 Node 版本上会排出不同顺序。参考音列表是设置页下拉框
 *   的数据源，顺序随环境抖动会让「上次选的那个在哪」变得不可预期，也让断言无法固定。
 *   排序的目的只是**稳定**（不是"符合某种语言学预期"），所以用 codepoint 就够。
 */
function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 列出目录里所有成对参考音。
 * 同时认两种结构：角色子目录（多情绪）与旧扁平文件（等价 neutral）。
 * 目录不存在 / 不可读 → 空数组（调用方按「只有内置音色」处理）。
 */
export function listVoiceEntries(dir: string = voicesDir()): VoiceEntry[] {
  const out: VoiceEntry[] = [];
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在 = 尚无自定义音色
  }

  // 先收集角色目录名：用于「目录优先于同名扁平文件」的判定。
  // ⚠️ 这不是理论情形 —— 用户从单份升级到多情绪时，一定是先有
  //    voices/foo.wav，再新建 voices/foo/neutral.wav，两者会并存一段时间。
  //    若都读出来，同一角色会出现两条 neutral（一条来自目录、一条来自旧文件），
  //    下拉里重复、resolveVoice 也会因 Map 覆盖顺序不确定而随机选一份。
  const dirNames = new Set(items.filter((it) => it.isDirectory()).map((it) => it.name));

  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      // 角色目录：<角色>/<情绪>.wav + <情绪>.txt
      let files: string[];
      try {
        files = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.wav')) continue;
        const emotion = f.slice(0, -4);
        const { wavPath, txtPath } = emotionPaths(full, emotion);
        if (!fs.existsSync(txtPath)) continue; // 落单 wav：未完成，不进列表
        out.push({ id: it.name, emotion, wavPath, txtPath });
      }
    } else if (it.isFile() && it.name.toLowerCase().endsWith('.wav')) {
      // 旧扁平结构：<角色>.wav + <角色>.txt ⇒ 视为该角色的 neutral
      const roleId = it.name.slice(0, -4);
      if (dirNames.has(roleId)) continue; // 同名目录已存在 ⇒ 目录权威，旧文件忽略
      const txtPath = path.join(dir, `${roleId}.txt`);
      if (!fs.existsSync(txtPath)) continue;
      out.push({ id: roleId, emotion: DEFAULT_EMOTION, wavPath: full, txtPath });
    }
  }

  // 排序：default 角色最前；其余按 key 的 codepoint 序；同角色内 neutral 最前（下拉框稳定）
  out.sort((a, b) => {
    if (a.id !== b.id) {
      if (a.id === DEFAULT_VOICE_ID) return -1;
      if (b.id === DEFAULT_VOICE_ID) return 1;
      return cmpKey(a.id, b.id);
    }
    if (a.emotion === b.emotion) return 0;
    if (a.emotion === DEFAULT_EMOTION) return -1;
    if (b.emotion === DEFAULT_EMOTION) return 1;
    return cmpKey(a.emotion, b.emotion);
  });
  return out;
}

/** 一个角色及其可用情绪（设置页下拉用） */
export interface VoiceRole {
  id: string;
  /** 已按 neutral 优先排序 */
  emotions: string[];
}

/** 列出所有角色（去重） */
export function listVoiceRoles(dir: string = voicesDir()): VoiceRole[] {
  const map = new Map<string, Set<string>>();
  for (const e of listVoiceEntries(dir)) {
    let s = map.get(e.id);
    if (!s) {
      s = new Set();
      map.set(e.id, s);
    }
    s.add(e.emotion);
  }
  const roles: VoiceRole[] = [];
  for (const [id, set] of map) {
    const emotions = [...set].sort((a, b) => {
      if (a === b) return 0;
      if (a === DEFAULT_EMOTION) return -1;
      if (b === DEFAULT_EMOTION) return 1;
      return cmpKey(a, b);
    });
    roles.push({ id, emotions });
  }
  roles.sort((a, b) => {
    if (a.id === DEFAULT_VOICE_ID) return -1;
    if (b.id === DEFAULT_VOICE_ID) return 1;
    return cmpKey(a.id, b.id);
  });
  return roles;
}

/** 解析结果：实际命中的文件 + 是否发生了情绪回退 */
export interface ResolvedVoice {
  entry: VoiceEntry;
  /** 请求的情绪（规范化后） */
  requested: string;
  /** 实际命中的情绪 */
  resolved: string;
  /** true = 请求的情绪没有参考音，走了回退（调用方应留痕，便于排查"为什么不像"） */
  fellBack: boolean;
}

/**
 * 按「角色 + 情绪」解析出一份参考音，找不到就沿近似链回退。
 * 返回 null ⇒ 该角色一份参考音都没有（调用方回退到内置音色）。
 *
 * ⚠️ 这里只做**纯查找**，不校验音频质量 —— 质检是 UI 的事（inspectVoiceQuality），
 *    不能让一份 30 秒的参考音导致 say 直接失败（宁可慢也别哑）。
 */
export function resolveVoice(
  voice: string | undefined,
  emotion?: string,
  dir: string = voicesDir(),
): ResolvedVoice | null {
  const role = (voice || DEFAULT_VOICE_ID).trim();
  const entries = listVoiceEntries(dir).filter((e) => e.id === role);
  if (entries.length === 0) return null;

  const byEmotion = new Map(entries.map((e) => [e.emotion, e]));
  const want = (emotion || DEFAULT_EMOTION).trim().toLowerCase();
  const chain = EMOTION_FALLBACKS[want] ?? [want, DEFAULT_EMOTION];

  for (const candidate of chain) {
    const hit = byEmotion.get(candidate);
    if (hit) return { entry: hit, requested: want, resolved: candidate, fellBack: candidate !== want };
  }

  // 词表外情绪 + 该角色连 neutral 都没有：退回它的第一份（总比哑掉强）
  const fallback = entries.find((e) => e.emotion === DEFAULT_EMOTION) ?? entries[0];
  return { entry: fallback, requested: want, resolved: fallback.emotion, fellBack: true };
}

// ── 参考音质检（设置页亮黄灯用；不参与解析决策）────────────────────

/** 参考音质检结果 */
export interface VoiceQuality {
  ok: boolean;
  durationSec: number;
  sampleRate: number;
  channels: number;
  transcriptChars: number;
  /** 人类可读的问题清单；空 = 合格 */
  warnings: string[];
}

/**
 * 读 WAV 头（只解析 chunk 结构，不读音频数据）。
 * 支持 PCM(int) 与 IEEE float —— 两者在 fmt chunk 里只差 audioFormat 字段，
 * 布局一致，所以同一个偏移读法通用。
 * 跳过 LIST / fact 等附加块（按 chunk size 前进，不假设 fmt 紧跟 RIFF）。
 */
export function inspectWav(
  file: string,
): { sampleRate: number; channels: number; bits: number; durationSec: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
    if (head.subarray(0, 4).toString() !== 'RIFF') return null;
    if (head.subarray(8, 12).toString() !== 'WAVE') return null;

    const stat = fs.statSync(file);
    let pos = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let dataSize = 0;
    const hdr = Buffer.alloc(8);

    while (pos + 8 <= stat.size) {
      if (fs.readSync(fd, hdr, 0, 8, pos) < 8) break;
      const id = hdr.subarray(0, 4).toString();
      const size = hdr.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(size, 64));
        fs.readSync(fd, fmt, 0, fmt.length, pos + 8);
        if (fmt.length >= 16) {
          channels = fmt.readUInt16LE(2);
          sampleRate = fmt.readUInt32LE(4);
          bits = fmt.readUInt16LE(14);
        }
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      pos += 8 + size + (size & 1); // chunk 按偶数字节对齐
    }

    if (!sampleRate || !channels || !bits) return null;
    return { sampleRate, channels, bits, durationSec: dataSize / (sampleRate * channels * (bits / 8)) };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 质检一份参考音：时长 / 采样率 / 声道 / 文字稿。
 *
 * 【为什么卡这几项】（2026-10-26 实测）
 *   · 时长 > 10s 会明显拖慢合成（同一句 19 字：3.5s 参考音 2.4s，15.9s 参考音 3.3s）
 *   · 立体声/低采样率不是不能跑，但模型内部还要转码，收益为负
 *   · 文字稿为空的克隆必失败（breeze 侧报 `clone requires reference_text`）
 */
export function inspectVoiceQuality(entry: VoiceEntry): VoiceQuality {
  const warnings: string[] = [];
  const info = inspectWav(entry.wavPath);
  let durationSec = 0;
  let sampleRate = 0;
  let channels = 0;

  if (!info) {
    warnings.push('WAV 头无法解析（不是标准 RIFF/WAVE）');
  } else {
    ({ durationSec, sampleRate, channels } = info);
    if (durationSec < 3) warnings.push(`参考音偏短（${durationSec.toFixed(1)}s，建议 3~10s）`);
    else if (durationSec > 10) warnings.push(`参考音偏长（${durationSec.toFixed(1)}s，建议 3~10s，过长会拖慢合成）`);
    if (sampleRate < 16000) warnings.push(`采样率偏低（${sampleRate} Hz，建议 ≥16k，24k 最佳）`);
    if (channels > 1) warnings.push(`立体声（${channels} 声道），建议转单声道`);
  }

  let transcriptChars = 0;
  try {
    transcriptChars = fs.readFileSync(entry.txtPath, 'utf8').trim().length;
  } catch {
    warnings.push('文字稿读取失败');
  }
  if (transcriptChars === 0) warnings.push('文字稿为空（克隆必须提供参考文本）');

  return { ok: warnings.length === 0, durationSec, sampleRate, channels, transcriptChars, warnings };
}

// ── 旧位置 → 新目录的一次性搬迁（幂等）────────────────────────────

/**
 * 旧位置 → 新目录的一次性搬迁（幂等）。旧位置两处：
 *   · `<modelDir>/prompt.wav` + `prompt.txt`        → `<voices>/default.wav` + `default.txt`
 *   · `<modelDir>/prompts/<id>.wav` + `<id>.txt`    → `<voices>/<id>.wav` + `<id>.txt`
 *
 * ⚠️ 搬到的是**扁平结构**（等价 neutral），不自动建角色目录 ——
 *    旧数据没有"角色/情绪"信息，硬猜会把用户资产放错地方。
 *
 * 规则：目标已存在 → **不覆盖**（用户新放的优先），旧文件原样保留并计入
 * kept（日志可见，避免静默留垃圾）；成功搬迁的源文件删除，保证只有一份。
 */
export function migrateLegacyVoices(
  modelDir: string,
  dir: string = voicesDir(),
): { moved: string[]; kept: string[] } {
  const moved: string[] = [];
  const kept: string[] = [];

  const pairs: Array<{ fromWav: string; fromTxt: string; id: string }> = [
    { fromWav: path.join(modelDir, 'prompt.wav'), fromTxt: path.join(modelDir, 'prompt.txt'), id: DEFAULT_VOICE_ID },
  ];
  const legacyPrompts = path.join(modelDir, 'prompts');
  try {
    for (const f of fs.readdirSync(legacyPrompts)) {
      if (!f.toLowerCase().endsWith('.wav')) continue;
      const id = f.slice(0, -4);
      if (id === DEFAULT_VOICE_ID) continue; // default 只认根目录的 prompt.*
      pairs.push({ fromWav: path.join(legacyPrompts, f), fromTxt: path.join(legacyPrompts, `${id}.txt`), id });
    }
  } catch {
    /* 无旧 prompts 目录 */
  }

  for (const p of pairs) {
    if (!(fs.existsSync(p.fromWav) && fs.existsSync(p.fromTxt))) continue; // 不成对：不搬（列不出来）
    const toWav = path.join(dir, `${p.id}.wav`);
    const toTxt = path.join(dir, `${p.id}.txt`);
    if (fs.existsSync(toWav) || fs.existsSync(toTxt)) {
      kept.push(p.id); // 新位置已有：不覆盖，旧文件保留原处
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(p.fromWav, toWav);
      fs.copyFileSync(p.fromTxt, toTxt);
      fs.rmSync(p.fromWav, { force: true });
      fs.rmSync(p.fromTxt, { force: true });
      moved.push(p.id);
    } catch {
      // 搬迁失败（权限/占用）：旧位置仍在，回退逻辑仍能读到 —— 不阻断
      kept.push(p.id);
    }
  }
  return { moved, kept };
}

/** 进程内一次性迁移（listVoices / 服务启动前调用；失败不阻断） */
let migratedOnce = false;
export interface MigrateResult {
  moved: string[];
  kept: string[];
}
export function ensureVoicesReady(modelDir: string, dir: string = voicesDir()): MigrateResult | null {
  if (migratedOnce) return null;
  migratedOnce = true;
  try {
    return migrateLegacyVoices(modelDir, dir);
  } catch {
    return null;
  }
}

/** 测试用：重置一次性标记 */
export function __resetVoicesMigrationForTest(): void {
  migratedOnce = false;
}
