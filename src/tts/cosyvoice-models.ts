/**
 * Fun-CosyVoice3 模型清单 — base / rl 两个变体的文件级下载计划。
 *
 * 仓库（HuggingFace / ModelScope 同源）：FunAudioLLM/Fun-CosyVoice3-0.5B-2512。
 * 关键结构：**base 与 rl 只差一个 LLM 权重文件**（llm.pt vs llm.rl.pt），其余
 * （flow / hift / speech_tokenizer / 词表 / campplus）两版共用 —— 换版本只需
 * 增量下载那一个文件（~1GB），不重复拉 2GB 的共用部分。
 *
 * 源码仓库不携带模型：清单在此，文件按需下载到 ~/.agent/models/tts/cosyvoice3/。
 */

import fs from 'node:fs';
import { getModelRoot } from '../runtime/model-root.js';
import path from 'node:path';

export type CosyVoiceVariant = 'base' | 'rl';

export interface CosyVoiceFileSpec {
  /** 仓库内路径（同时也是落盘的相对路径） */
  path: string;
  /** 近似大小（MB，用于 UI 提示；实际以 content-length 为准） */
  approxMB: number;
  /** 归属：common=两版共用 / 仅该 variant 需要 */
  group: 'common' | CosyVoiceVariant;
}

export const COSYVOICE_DIR = () => path.join(getModelRoot(), 'tts', 'cosyvoice3');

const FILES: CosyVoiceFileSpec[] = [
  { path: 'llm.pt', approxMB: 1100, group: 'base' },
  { path: 'llm.rl.pt', approxMB: 1100, group: 'rl' },
  { path: 'flow.pt', approxMB: 480, group: 'common' },
  { path: 'hift.pt', approxMB: 350, group: 'common' },
  { path: 'flow.decoder.estimator.fp32.onnx', approxMB: 640, group: 'common' },
  { path: 'speech_tokenizer_v3.onnx', approxMB: 130, group: 'common' },
  { path: 'campplus.onnx', approxMB: 27, group: 'common' },
  { path: 'cosyvoice3.yaml', approxMB: 0, group: 'common' },
  { path: 'CosyVoice-BlankEN/config.json', approxMB: 0, group: 'common' },
  { path: 'CosyVoice-BlankEN/generation_config.json', approxMB: 0, group: 'common' },
  { path: 'CosyVoice-BlankEN/merges.txt', approxMB: 1, group: 'common' },
  { path: 'CosyVoice-BlankEN/model.safetensors', approxMB: 990, group: 'common' },
  { path: 'CosyVoice-BlankEN/tokenizer_config.json', approxMB: 0, group: 'common' },
  { path: 'CosyVoice-BlankEN/vocab.json', approxMB: 2, group: 'common' },
];

/** 某变体需要的全部文件（共用 + 该版本的 LLM 权重） */
export function filesFor(variant: CosyVoiceVariant): CosyVoiceFileSpec[] {
  return FILES.filter((f) => f.group === 'common' || f.group === variant);
}

/** 某变体还缺哪些文件（未下载的） */
export function missingFiles(variant: CosyVoiceVariant): CosyVoiceFileSpec[] {
  const dir = COSYVOICE_DIR();
  return filesFor(variant).filter((f) => {
    try {
      return !fs.statSync(path.join(dir, f.path)).isFile();
    } catch {
      return true;
    }
  });
}

/** 下载直链（按 mirrorPref 排序：锁定源优先，失败仍回落其它源；'' = hf-mirror 优先） */
export function fileUrls(repoPath: string, mirrorPref?: string): string[] {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  const sources = [
    { id: 'hf-mirror', url: `https://hf-mirror.com/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/${encoded}` },
    { id: 'huggingface', url: `https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/${encoded}` },
  ];
  if (mirrorPref === 'hf-mirror' || mirrorPref === 'huggingface') {
    const locked = sources.filter((x) => x.id === mirrorPref).map((x) => x.url);
    return [...locked, ...sources.filter((x) => x.id !== mirrorPref).map((x) => x.url)];
  }
  return sources.map((x) => x.url);
}
