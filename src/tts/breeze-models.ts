/**
 * BreezeTTS-2 模型清单 —— GGUF 权重 + audio.cpp 运行时（exe + CUDA 运行库）。
 *
 * 【为什么和 cosyvoice-models.ts 分开】两者下载源、产物形态、校验方式都不同：
 *   · cosyvoice：HF 仓库里的散装权重文件（.pt/.onnx），纯文件落盘即可
 *   · breeze    ：一份 GGUF（5.08GB，hf-mirror 直链）
 *               + **GitHub Release 的 zip 包**（audiocpp_cli.exe / audiocpp_server.exe
 *                 + 一堆 dll），解压后才是可用形态
 *   混在一起会让「文件级校验」和「解包落位」两套逻辑互相污染。
 *
 * 【来源与验证（2026-10-26 实测，不是照文档抄的）】
 *   · GGUF：hf-mirror 返回 200，Content-Length = 5079670336
 *     —— 与用户 F 盘已有的 breeze-tts-2-q8_0.gguf **逐字节等大**，可直接当校验基线。
 *   · 运行时：GitHub Release 资产列表实测可枚举（tag 见 BREEZE_DEFAULT_RELEASE）。
 *     注意资产分 **bin**（可执行 + 依赖 dll）和 **cudart**（CUDA 运行库）两个包，
 *     **必须都装**：只装 bin 会在启动时报 0xC0000135（找不到 cudart64_*.dll）。
 *   · `api.github.com` 仍 403（代理未覆盖该子域）⇒ 下载器**不依赖 API**，
 *     一律走已知的 release 直链拼接。
 *
 * 【tag 为什么要钉住】用 `releases/latest` 拿 tag 等于把「哪天上游发新版」这件事
 *   接进运行时 —— 上游一次改资产命名，下载器就静默失效。默认钉一个验证过的 tag，
 *   要升级时改这里或走配置覆盖。
 *
 * 【接线状态（2026-10-26 明确记录，别当成漏接线）】
 *   本模块目前**没有任何调用方**，是**有意为之**，不是遗漏。第二档的交付范围就是
 *   「清单」这一层（对齐 `cosyvoice-models.ts` 的分层：清单可被 UI 直接读来做「缺什么」
 *   展示，不需要触发 IO；下载执行才是另一层）。
 *
 *   执行器写过一版又撤了，原因是**两个真冲突尚未解决**，硬接上去会害人：
 *    1. **路径语义对立**：本模块的 `ggufReady()` / `runtimeReady()` 只认
 *       `BREEZE_DIR()`（`<models.root>/tts/breeze-tts-2/`），而运行时实际用的是配置里的
 *       `voice.tts.breeze.cliPath` / `modelPath`（用户机器上指向 `<TTS安装目录>\...`）。
 *       两者可以完全不同 ⇒ 在「已装好但在别的盘」的机器上，执行器会判定「全缺」
 *       并重新下 5GB。必须先统一「受管安装位」与「实际运行位」的语义，
 *       或者让执行器尊重已配置的 cliPath/modelPath，才谈得上接 UI。
 *    2. **误触代价大**：GGUF q8_0 = 5.08GB + bin 263MB + cudart 548MB。在磁盘吃紧的
 *       机器上，一个不该出现的「下载」按钮就是事故。接 UI 前应先保证「已就绪时按钮
 *       不出现」的判断是对的 —— 而它依赖第 1 条的解决。
 *
 *   若将来要接：`stt/download.ts` 的 `downloadFile`（已导出）负责下载，
 *   `local-model/download-manager.ts` 的 `extractZipToDir` 负责解包（**当前未导出**，
 *   需导出或复制）。两个 zip 内部都是**根级散放**（2026-10-26 实测中央目录：
 *   bin 270 条 / cudart 4 条，顶层只有 `(root)` + `tools` + `model_specs`）
 *   ⇒ 直接解到目标目录，不需要「下钻一层」。**bin 与 cudart 必须解到同一目录**，
 *   缺 cudart 时 exe 启动即 0xC0000135。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getModelRoot } from '../runtime/model-root.js';

/** 本模块产物的落点：<models.root>/tts/breeze-tts-2/ */
export const BREEZE_DIR = (): string => path.join(getModelRoot(), 'tts', 'breeze-tts-2');

/** 运行时（exe + dll）解压到该子目录，与 GGUF 分开，便于整体替换 */
export const BREEZE_RUNTIME_DIR = (): string => path.join(BREEZE_DIR(), 'audio-cpp');

/** 已实测可用的 release tag（当日 releases/latest 指向它） */
export const BREEZE_DEFAULT_RELEASE = 'v0.9.2-drama3-base-small';

/** 上游仓库（下载 URL 与文档出处） */
export const BREEZE_REPO = '0xShug0/audio.cpp';
/** HF 上的 GGUF 仓库 */
export const BREEZE_HF_REPO = 'audio-cpp/audio.cpp-gguf';
/** HF 仓库内的子目录（GGUF 都放在这里） */
const BREEZE_HF_SUBDIR = 'Breeze-TTS-2-GGUF';

export type BreezeGgufVariant = 'q8_0' | 'q4_k' | 'q4_0' | 'bf16';

export interface BreezeGgufSpec {
  variant: BreezeGgufVariant;
  /** 仓库内文件名 */
  file: string;
  /** 实测/官方标注大小（GB，UI 提示用；真实以 Content-Length 为准） */
  approxGB: number;
  /** 一句话说明（质量/速度取舍） */
  note: string;
}

/**
 * 四个量化档（官方口径）：
 *   q8_0 默认推荐 —— 官方实测 RTF 从 bf16 的 ~1.5 降到 ~0.95（gfx1151）
 *   q4_k 更快（~0.84），但质量余量更小
 *   bf16 是模型训练精度，最稳但最慢最占显存
 *   q4_0 更激进，仅在显存极紧时考虑
 * ⚠️ 官方明确警告 **fp32 是最差配置**（乱读 + 复读）—— 本清单不提供，避免用户选到坑里。
 */
export const BREEZE_GGUF_VARIANTS: BreezeGgufSpec[] = [
  { variant: 'q8_0', file: 'breeze-tts-2-q8_0.gguf', approxGB: 5.08, note: '默认推荐：质量与速度平衡（官方 RTF ~0.95）' },
  { variant: 'q4_k', file: 'breeze-tts-2-q4_k.gguf', approxGB: 2.7, note: '最快、显存占用最小（RTF ~0.84），质量余量较小' },
  { variant: 'q4_0', file: 'breeze-tts-2-q4_0.gguf', approxGB: 2.5, note: '更激进量化，仅在显存极紧时用' },
  { variant: 'bf16', file: 'breeze-tts-2-bf16.gguf', approxGB: 9.6, note: '训练精度，最稳但最慢最占显存（8GB 卡放不下）' },
];

/** 取某变体的规格（未知变体抛错，避免静默回落到别的档位） */
export function ggufSpec(variant: BreezeGgufVariant): BreezeGgufSpec {
  const hit = BREEZE_GGUF_VARIANTS.find((v) => v.variant === variant);
  if (!hit) throw new Error(`未知的 breeze GGUF 变体：${variant}`);
  return hit;
}

/** GGUF 落盘绝对路径 */
export function ggufPath(variant: BreezeGgufVariant): string {
  return path.join(BREEZE_DIR(), ggufSpec(variant).file);
}

/** GGUF 是否已就绪（存在且非空 —— 半截文件不算） */
export function ggufReady(variant: BreezeGgufVariant): boolean {
  try {
    return fs.statSync(ggufPath(variant)).size > 0;
  } catch {
    return false;
  }
}

/**
 * GGUF 下载直链（多源顺序：hf-mirror 优先 —— 国内可达；官方 HF 作回落）。
 * mirrorPref 可锁定源（'hf-mirror' | 'huggingface'），锁定的排前面但仍保留另一个作回落。
 */
export function ggufUrls(variant: BreezeGgufVariant, mirrorPref?: string): string[] {
  const file = ggufSpec(variant).file;
  const encoded = `${BREEZE_HF_SUBDIR}/${file}`.split('/').map(encodeURIComponent).join('/');
  const sources = [
    { id: 'hf-mirror', url: `https://hf-mirror.com/${BREEZE_HF_REPO}/resolve/main/${encoded}` },
    { id: 'huggingface', url: `https://huggingface.co/${BREEZE_HF_REPO}/resolve/main/${encoded}` },
  ];
  if (mirrorPref === 'hf-mirror' || mirrorPref === 'huggingface') {
    return [
      ...sources.filter((s) => s.id === mirrorPref).map((s) => s.url),
      ...sources.filter((s) => s.id !== mirrorPref).map((s) => s.url),
    ];
  }
  return sources.map((s) => s.url);
}

// ────────────────────────────────────────────────────────────
// audio.cpp 运行时（GitHub Release）
// ────────────────────────────────────────────────────────────

export type BreezePlatform = 'windows-x64';
export type BreezeRuntimeBackend = 'cuda13.3' | 'cuda12.4' | 'cpu' | 'vulkan';

export interface BreezeRuntimeAsset {
  /** 资产文件名 */
  name: string;
  /** 这一包干什么（UI 提示） */
  kind: 'bin' | 'cudart' | 'lib';
}

/**
 * 按平台/后端拼出 release 资产名。
 *
 * 命名规律（实测枚举得出）：`audio-<tag>-<kind>-<platform>-<backend>.zip`
 *   kind = bin（可执行）/ lib（开发库，我们不需要）/ cudart（CUDA 运行库）
 *   backend ∈ cuda13.3 / cuda12.4 / cpu / vulkan（windows-x64 四档都有）
 *
 * **只返回 bin + cudart 两包**：lib 是给二次开发的，跑 CLI 用不上；
 * 而 cudart 必须装（缺了启动即 0xC0000135）。
 */
export function runtimeAssets(
  backend: BreezeRuntimeBackend,
  release = BREEZE_DEFAULT_RELEASE,
  platform: BreezePlatform = 'windows-x64',
): BreezeRuntimeAsset[] {
  const base = `audio-${release}-`;
  const suffix = `-${platform}-${backend}.zip`;
  return [
    { name: `${base}bin${suffix}`, kind: 'bin' },
    { name: `${base}cudart${suffix}`, kind: 'cudart' },
  ];
}

/**
 * release 资产下载直链（多源：GitHub 直连优先，ghfast.top 代理作回落）。
 *
 * ⚠️ 与 scratchpad 里「GitHub 只有 ghfast.top」的旧结论不同：2026-10-26 实测
 *    `github.com` 返回 200 且解析到真实 IP（代理开着），直链本身可用。
 *    但代理不是恒定状态，故保留 ghfast.top 作第二源 —— 两条都试才算稳。
 */
export function runtimeUrls(assetName: string, release = BREEZE_DEFAULT_RELEASE): string[] {
  const direct = `https://github.com/${BREEZE_REPO}/releases/download/${release}/${assetName}`;
  return [direct, `https://ghfast.top/${direct}`];
}

/** 运行时是否就绪：两个 exe 都在才算（dll 缺失只有跑起来才知道，不在这里穷举） */
export function runtimeReady(): boolean {
  const dir = BREEZE_RUNTIME_DIR();
  const need = ['audiocpp_cli.exe', 'audiocpp_server.exe'];
  return need.every((f) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });
}

/**
 * 按本机能力推荐后端。
 *
 * 为什么默认 cuda13.3：scratchpad 记录本机驱动 610.62（CUDA 13.3 运行时）。
 * 驱动只保证「向下兼容」，所以 13.3 优先、12.4 兜底 —— 具体哪个能跑要靠实际启动验证，
 * 这里只做推荐，不做保证（选错了会在启动时报缺 dll，属可见失败）。
 */
export function recommendedBackend(): BreezeRuntimeBackend {
  return 'cuda13.3';
}

/** 一句话说明当前缺什么（UI 直接显示，免去用户自己拼原因） */
export function breezeReadiness(variant: BreezeGgufVariant = 'q8_0'): {
  gguf: boolean;
  runtime: boolean;
  detail: string;
} {
  const gguf = ggufReady(variant);
  const runtime = runtimeReady();
  const missing: string[] = [];
  if (!runtime) missing.push('audio.cpp 运行时（bin + cudart）');
  if (!gguf) missing.push(`GGUF 权重（${variant}）`);
  return {
    gguf,
    runtime,
    detail: missing.length === 0 ? '就绪' : `缺：${missing.join('、')}`,
  };
}
