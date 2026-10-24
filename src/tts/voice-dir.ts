/**
 * 语音参考音目录 —— say/TTS 的音色资产（用户录音，不可再生）。
 *
 * 为什么独立于模型目录（2026-10-24 定）：模型目录是**可丢弃、可重建的下载
 * 缓存**，而参考音是用户自己录的素材。此前音色放在
 * `<models.root>/tts/cosyvoice3/prompts/`、默认音色放模型目录根的
 * `prompt.wav` —— 换盘（models.root 变更）后音色列表直接变空、清理重下
 * 模型时参考音被一并删掉。现在统一到：
 *
 *   <models.root>/voices/<音色id>.wav + <音色id>.txt
 *
 * 位置仍跟随 models.root（大文件换盘时一起走），但不在模型产物目录内 ——
 * 删模型/重下模型不会碰到它。
 *
 * 音色对约定：wav = 声音样本（≥16kHz，≤30s），txt = 该样本的逐字文字稿。
 * 只有成对的才进音色列表（落单的视为未完成，不列出）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getModelRoot } from '../runtime/model-root.js';

/** 参考音目录（跟随 models.root；与模型权重目录解耦） */
export function voicesDir(): string {
  return path.join(getModelRoot(), 'voices');
}

/** 默认音色的 id（空 voice 参数时使用；也是零样本回退音色） */
export const DEFAULT_VOICE_ID = 'default';

/** 一条可用音色（wav + txt 成对存在） */
export interface VoiceEntry {
  id: string;
  wavPath: string;
  txtPath: string;
}

/**
 * 列出目录里的音色对（wav 且有同名 txt 才算）。
 * 目录不存在 / 不可读 → 空数组（调用方按「只有默认音色」处理）。
 */
export function listVoiceEntries(dir: string = voicesDir()): VoiceEntry[] {
  const out: VoiceEntry[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.wav')) continue;
      const id = f.slice(0, -4);
      const wavPath = path.join(dir, f);
      const txtPath = path.join(dir, `${id}.txt`);
      if (!fs.existsSync(txtPath)) continue;   // 落单 wav：未完成，不进列表
      out.push({ id, wavPath, txtPath });
    }
  } catch {
    // 目录不存在 = 尚无自定义音色
  }
  return out.sort((a, b) => (a.id === DEFAULT_VOICE_ID ? -1 : b.id === DEFAULT_VOICE_ID ? 1 : a.id.localeCompare(b.id)));
}

/**
 * 旧位置 → 新目录的一次性搬迁（幂等）。旧位置两处：
 *   · `<modelDir>/prompt.wav` + `prompt.txt`        → `<voices>/default.*`
 *   · `<modelDir>/prompts/<id>.wav` + `<id>.txt`    → `<voices>/<id>.*`
 *
 * 规则：目标已存在 → **不覆盖**（用户新放的优先），旧文件原样保留并计入
 * kept（日志可见，避免静默留垃圾）；成功搬迁的源文件删除，保证只有一份。
 * 返回 moved / kept 供调用方记日志。
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
      if (id === DEFAULT_VOICE_ID) continue;   // default 只认根目录的 prompt.*
      pairs.push({ fromWav: path.join(legacyPrompts, f), fromTxt: path.join(legacyPrompts, `${id}.txt`), id });
    }
  } catch { /* 无旧 prompts 目录 */ }

  for (const p of pairs) {
    if (!(fs.existsSync(p.fromWav) && fs.existsSync(p.fromTxt))) continue;   // 不成对：不搬（列不出来）
    const toWav = path.join(dir, `${p.id}.wav`);
    const toTxt = path.join(dir, `${p.id}.txt`);
    if (fs.existsSync(toWav) || fs.existsSync(toTxt)) {
      kept.push(p.id);   // 新位置已有：不覆盖，旧文件保留原处
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
export interface MigrateResult { moved: string[]; kept: string[] }
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
