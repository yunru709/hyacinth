/**
 * 多模态/图片管线 — 用户输入图片检测、压缩、索引、回收
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MessageContent } from '../types.js';
import { extractFrames } from './ffmpeg.js';
import { recordMediaFile } from '../media/index.js';

// ── view_media 的 `capture` 抓源（2026-10-29，不落盘版）──────────────────
// spawn `~/.agent/bin/WgcCap.exe`：camera→`cam -`、window:<标题>→`win <标题> -`；
// `-` ⇒ PNG 以 base64 写 stdout，这里读进内存直进 imageStore，全程不产生临时文件。
async function runCapture(spec: string): Promise<{ error?: string; base64?: string }> {
  const os = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const exe = path.join(os.homedir(), '.agent', 'bin', 'WgcCap.exe');
  if (!fs.existsSync(exe)) return { error: 'Error: 抓源组件缺失（~/.agent/bin/WgcCap.exe 未构建）' };
  let args: string[];
  if (spec === 'camera') {
    args = ['cam', '-'];
  } else if (spec.startsWith('window:')) {
    const titleLike = spec.slice('window:'.length).trim();
    if (!titleLike) return { error: 'Error: capture=window:<标题片段> 需要标题片段' };
    args = ['win', titleLike, '-'];
  } else {
    return { error: `Error: 未知 capture="${spec}"（支持 window:<标题> / camera）` };
  }
  try {
    const { stdout } = await execFileAsync(exe, args, { timeout: 20000, windowsHide: true, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' });
    const b64 = (stdout || '').trim();
    if (!b64 || b64.length < 100) return { error: `Error: 抓源失败(${spec})：无有效图像输出（窗口没找到 / 相机被占用?）` };
    return { base64: b64 };
  } catch (e) {
    return { error: `Error: 抓源失败(${spec})(${e instanceof Error ? e.message : String(e)})` };
  }
}


// ── MIME 映射 ───────────────────────────────────────────────────────

export const IMAGE_MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
};

/** 视频扩展名 → MIME（多模态输入） */
export const VIDEO_MIME_MAP: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/x-m4v',
};

/** 音频扩展名 → MIME（多模态输入） */
export const AUDIO_MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
};

const IMAGE_EXTS = ['png', 'jpe?g', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff?'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'];
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus'];

// ── ImageStore — 会话级图片内存索引 ────────────────────────────────

interface ImageRecord {
  data: string;       // base64
  media_type: string;
  source_path: string;
  description: string;
  byteSize: number;
  indexedAt: string;
}

export class ImageStore {
  private images = new Map<string, ImageRecord>();
  private _hashIndex = new Map<string, string>();
  private _cachedList = '';
  private _dirty = true;
  private nextSeq = 1;

  /**
   * 内容指纹 —— 必须**真正把内容纳入哈希**。
   *
   * ⚠️ 历史 bug（2026-10-22 核实并实证）：旧实现是
   *   `${mediaType}:${base64Data.length}:${head.length}:${tail.length}`
   * head/tail 恒取 512 字符 ⇒ 对任何 >768 字节的图，后两段**恒为 512**
   * ⇒ 哈希退化成「媒体类型 + 总长度」。而 `store()` 命中即 `return existing`
   * （不入库、不覆盖、无日志）⇒ 同类型、同字节长度的两张**不同**图，
   * 第二张会静默复用第一张的 id，用户看到的是上一张图。
   * 实测：两个 32 字符的等长不同 base64 都返回 `img_001`，`list().length === 1`。
   *
   * 改法：sha256 全量内容（对几 MB 的图也只是毫秒级，只在 store 时算一次）。
   * 以后改这里必须保留「内容参与哈希」这一点，别退回到取长度/取片段。
   */
  private _contentHash(base64Data: string, mediaType: string): string {
    return crypto
      .createHash('sha256')
      .update(mediaType)
      .update('\0')
      .update(base64Data)
      .digest('hex');
  }

  store(base64Data: string, mediaType: string, sourcePath?: string): string {
    const hash = this._contentHash(base64Data, mediaType);
    const existing = this._hashIndex.get(hash);
    if (existing) return existing;
    const id = `img_${String(this.nextSeq).padStart(3, '0')}`;
    this.nextSeq++;
    const decodedBytes = Math.ceil(base64Data.length * 0.75);
    this.images.set(id, {
      data: base64Data, media_type: mediaType,
      source_path: sourcePath || '', description: '',
      byteSize: decodedBytes, indexedAt: new Date().toISOString(),
    });
    this._hashIndex.set(hash, id);
    this._dirty = true;
    return id;
  }

  get(id: string): ImageRecord | null {
    return this.images.get(id) ?? null;
  }

  /**
   * 清空全部索引。
   *
   * ⚠️ C-08（2026-10-22 修复）：切会话时 orchestrator 会清 11 项会话态，**却没有一项涉及图片**
   * （`pendingImageInjections` 只在 context 阶段消费后原地清空），而 `ImageStore` 也没有
   * clear/reset/TTL ⇒ 切到新会话后旧的 `img_001..N` 仍然可被 `view_image` 命中，
   * 等于把上一个会话的图带进了新会话。
   */
  clear(): void {
    this.images.clear();
    this._hashIndex.clear();
    this._cachedList = '';
    this._dirty = true;
    this.nextSeq = 1;
  }

  setDescription(id: string, desc: string): void {
    const img = this.images.get(id);
    if (img) { img.description = desc; this._dirty = true; }
  }

  list(): { id: string; media_type: string; description: string; byteSize: number; source_path: string; indexedAt: string }[] {
    return [...this.images.entries()].map(([id, img]) => ({
      id, media_type: img.media_type, description: img.description,
      byteSize: img.byteSize, source_path: img.source_path, indexedAt: img.indexedAt,
    }));
  }

  listForContext(): string {
    if (!this._dirty) return this._cachedList;
    const undescribed = this.list().filter(e => !e.description);
    if (undescribed.length === 0) { this._cachedList = ''; }
    else {
      this._cachedList = undescribed.map(e => {
        const sizeStr = e.byteSize < 1024 ? `${e.byteSize}B` : `${(e.byteSize / 1024).toFixed(1)}KB`;
        return `[Image #${e.id}: ${e.media_type.split('/')[1]?.toUpperCase() || 'IMG'}, ${sizeStr} — view_image("${e.id}") to re-examine]`;
      }).join('\n');
    }
    this._dirty = false;
    return this._cachedList;
  }
}

// ── 图片压缩 ────────────────────────────────────────────────────────

export async function compressImageIfLarge(
  buf: Buffer, mime: string,
): Promise<{ buffer: Buffer; mime: string; compressed: boolean }> {
  const MAX_DIM = 2048;
  const COMPRESS_THRESHOLD = 300 * 1024;
  if (buf.length <= COMPRESS_THRESHOLD) return { buffer: buf, mime, compressed: false };
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch { return { buffer: buf, mime, compressed: false }; }
  try {
    const image = sharp(buf);
    const metadata = await image.metadata();
    const longEdge = Math.max(metadata.width || 0, metadata.height || 0);
    let pipeline = image;
    if (longEdge > MAX_DIM) {
      pipeline = pipeline.resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });
    }
    const hasAlpha = metadata.hasAlpha ?? false;
    const outMime = (mime === 'image/png' && hasAlpha) ? 'image/png' : 'image/jpeg';
    if (outMime === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 80 });
    else pipeline = pipeline.png({ quality: 80, palette: true });
    const compressed = await pipeline.toBuffer();
    return { buffer: compressed, mime: outMime, compressed: true };
  } catch {
    return { buffer: buf, mime, compressed: false };
  }
}

// ── 路径检测 ────────────────────────────────────────────────────────

/** 通用：识别文本中的本地媒体路径（扩展名白名单，存在且是文件） */
export function detectMediaPaths(text: string, exts: string[]): string[] {
  const paths: string[] = [];
  const pathRegex = new RegExp(
    `(?:["'\`])?((?:[A-Za-z]:[^"'\n\r]*|(?:\\/|\\.\\.?\\/)[^"'\n\r]*)\\.(?:${exts.join('|')}))(?:["'\`])?`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    const p = match[1]!;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) paths.push(p);
  }
  return paths;
}

export function detectImagePaths(text: string): string[] {
  return detectMediaPaths(text, IMAGE_EXTS);
}

export function detectVideoPaths(text: string): string[] {
  return detectMediaPaths(text, VIDEO_EXTS);
}

export function detectAudioPaths(text: string): string[] {
  return detectMediaPaths(text, AUDIO_EXTS);
}

// ── 构建带多模态的用户消息（本地路径：图片/视频/音频）────────────────

const LARGE_IMAGE_BYTES = 500 * 1024;
const DEFAULT_VIDEO_INLINE_MAX = 10 * 1024 * 1024; // 原生视频内联上限（配置覆盖）
const DEFAULT_VIDEO_MAX_FRAMES = 16;               // 抽帧上限（硬约束，防 token 激增）
const DEFAULT_AUDIO_INLINE_MAX = 15 * 1024 * 1024; // 音频内联上限（配置覆盖）

/** 图片路径 → ImageContent 块数组（不含尾部用户输入文本） */
async function buildImageBlocks(
  userInput: string,
  imageStore: ImageStore,
): Promise<MessageContent[]> {
  const imagePaths = detectImagePaths(userInput);
  const blocks: MessageContent[] = [];

  for (const imgPath of imagePaths) {
    const ext = path.extname(imgPath).toLowerCase().replace('.', '');
    const mime = IMAGE_MIME_MAP[ext] || 'image/png';
    try {
      let buf = (await fs.promises.readFile(imgPath)) as Buffer;
      let outMime = mime;
      if (buf.length > LARGE_IMAGE_BYTES) {
        const result = await compressImageIfLarge(buf, mime);
        if (result.compressed) { buf = result.buffer; outMime = result.mime; }
      }
      const b64 = buf.toString('base64');
      const imgId = imageStore.store(b64, outMime, imgPath);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: outMime, data: b64 } });
      const sizeStr = buf.length < 1024 ? `${buf.length}B` : `${(buf.length / 1024).toFixed(1)}KB`;
      const estTokens = Math.ceil(b64.length * 0.75 / 4);
      const warn = estTokens > 2000 ? ` ⚠️ ~${estTokens} tokens` : '';
      blocks.push({ type: 'text', text: `[Image indexed as #${imgId}: ${ext.toUpperCase()}, ${sizeStr}${warn}]` });
    } catch {
      blocks.push({ type: 'text', text: `[Failed to read image: ${imgPath}]` });
    }
  }
  return blocks;
}

export async function buildUserContentWithImages(
  userInput: string, imageStore: ImageStore,
): Promise<MessageContent | MessageContent[]> {
  const blocks = await buildImageBlocks(userInput, imageStore);
  if (blocks.length === 0) return { type: 'text', text: userInput };
  return [...blocks, { type: 'text', text: userInput }];
}

/** 统一媒体管线选项（阈值由外部配置注入；缺省走模块默认） */
export interface MediaPipelineOptions {
  imageStore: ImageStore;
  /** 模型支持原生视频输入 */
  supportsVideo?: boolean;
  /** 模型支持原生音频输入 */
  supportsAudio?: boolean;
  /** 视频内联上限（字节） */
  videoInlineMaxBytes?: number;
  /** 视频抽帧上限（帧数） */
  videoMaxFrames?: number;
  /** 音频内联上限（字节） */
  audioInlineMaxBytes?: number;
}

/** 视频路径 → 原生视频块 / 抽帧图片数组 / 占位（双轨自动降级） */
async function buildVideoBlocks(
  userInput: string,
  opts: MediaPipelineOptions,
): Promise<MessageContent[]> {
  const videoPaths = detectVideoPaths(userInput);
  if (videoPaths.length === 0) return [];
  const blocks: MessageContent[] = [];
  const inlineMax = opts.videoInlineMaxBytes ?? DEFAULT_VIDEO_INLINE_MAX;
  const maxFrames = opts.videoMaxFrames ?? DEFAULT_VIDEO_MAX_FRAMES;

  for (const videoPath of videoPaths) {
    const ext = path.extname(videoPath).toLowerCase().replace('.', '');
    const mime = VIDEO_MIME_MAP[ext] || 'video/mp4';
    try {
      const stat = fs.statSync(videoPath);
      if (!stat.isFile()) { blocks.push({ type: 'text', text: `[Video not found: ${videoPath}]` }); continue; }

      // 轨道一：原生视频内联（模型支持 video 且未超限）
      if (opts.supportsVideo && stat.size <= inlineMax) {
        const buf = (await fs.promises.readFile(videoPath)) as Buffer;
        blocks.push({
          type: 'video',
          source: { type: 'base64', media_type: mime, data: buf.toString('base64') },
          media_type: mime,
        });
        blocks.push({ type: 'text', text: `[Video: ${mime.split('/')[1]?.toUpperCase()}, ${(stat.size / 1024 / 1024).toFixed(1)}MB]` });
        continue;
      }

      // 轨道二：ffmpeg 抽帧 → 图片数组（模型不支持 / 超限；无 ffmpeg 时返回 []）
      const frames = await extractFrames(videoPath, { fps: 1, max_frames: maxFrames, max_long_side_pixel: 1024 });
      if (frames.length > 0) {
        for (let i = 0; i < frames.length; i++) {
          let frameBuf = frames[i];
          let outMime = 'image/png';
          if (frameBuf.length > LARGE_IMAGE_BYTES) {
            const comp = await compressImageIfLarge(frameBuf, 'image/png');
            if (comp.compressed) { frameBuf = comp.buffer; outMime = comp.mime; }
          }
          const b64 = frameBuf.toString('base64');
          const imgId = opts.imageStore.store(b64, outMime, videoPath);
          blocks.push({ type: 'image', source: { type: 'base64', media_type: outMime, data: b64 } });
          const estTokens = Math.ceil(b64.length * 0.75 / 4);
          blocks.push({ type: 'text', text: `[Video frame ${i + 1}/${frames.length} from ${videoPath}: #${imgId}, ~${estTokens} tokens]` });
        }
        continue;
      }

      // 轨道三：无 ffmpeg 且不支持原生 → 占位提示（尽力归档到媒体库）
      let archived = '';
      try {
        const rec = recordMediaFile(videoPath, { type: 'video', source: 'user' });
        if (rec) archived = `（已归档媒体库 #${rec.id.slice(0, 8)}）`;
      } catch { /* 归档失败不阻断 */ }
      blocks.push({ type: 'text', text: `[Video file: ${videoPath}${archived} — 模型不支持原生视频且无法抽帧，需先转成图片]` });
    } catch {
      blocks.push({ type: 'text', text: `[Failed to read video: ${videoPath}]` });
    }
  }
  return blocks;
}

/** 音频路径 → 原生音频块 / 占位 */
async function buildAudioBlocks(
  userInput: string,
  opts: MediaPipelineOptions,
): Promise<MessageContent[]> {
  const audioPaths = detectAudioPaths(userInput);
  if (audioPaths.length === 0) return [];
  const blocks: MessageContent[] = [];
  const inlineMax = opts.audioInlineMaxBytes ?? DEFAULT_AUDIO_INLINE_MAX;

  for (const audioPath of audioPaths) {
    const ext = path.extname(audioPath).toLowerCase().replace('.', '');
    const mime = AUDIO_MIME_MAP[ext] || 'audio/mpeg';
    try {
      const stat = fs.statSync(audioPath);
      if (!stat.isFile()) { blocks.push({ type: 'text', text: `[Audio not found: ${audioPath}]` }); continue; }
      if (opts.supportsAudio && stat.size <= inlineMax) {
        const buf = (await fs.promises.readFile(audioPath)) as Buffer;
        blocks.push({
          type: 'audio',
          source: { type: 'base64', media_type: mime, data: buf.toString('base64') },
          media_type: mime,
        });
        blocks.push({ type: 'text', text: `[Audio: ${mime.split('/')[1]?.toUpperCase()}, ${(stat.size / 1024 / 1024).toFixed(1)}MB]` });
      } else {
        let archived = '';
        try {
          const rec = recordMediaFile(audioPath, { type: 'audio', source: 'user' });
          if (rec) archived = `（已归档媒体库 #${rec.id.slice(0, 8)}）`;
        } catch { /* 归档失败不阻断 */ }
        blocks.push({ type: 'text', text: `[Audio file: ${audioPath}${archived}]` });
      }
    } catch {
      blocks.push({ type: 'text', text: `[Failed to read audio: ${audioPath}]` });
    }
  }
  return blocks;
}

/** 统一媒体入口：检测图片/视频/音频路径 → 构造内容块 + 尾部用户输入文本 */
export async function buildUserContentWithMedia(
  userInput: string,
  opts: MediaPipelineOptions,
): Promise<MessageContent | MessageContent[]> {
  const blocks: MessageContent[] = [
    ...(await buildImageBlocks(userInput, opts.imageStore)),
    ...(await buildVideoBlocks(userInput, opts)),
    ...(await buildAudioBlocks(userInput, opts)),
  ];
  if (blocks.length === 0) return { type: 'text', text: userInput };
  return [...blocks, { type: 'text', text: userInput }];
}

// ── 图片文件 → ImageStore（view_image 路径回看用）────────────────────

/** 读取本地图片文件 → 压缩 → 入 ImageStore。返回 { id, data, media_type } 或 null（非文件/读取失败） */
export async function loadImageFileToStore(
  filePath: string,
  imageStore: ImageStore,
): Promise<{ id: string; data: string; media_type: string } | null> {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = IMAGE_MIME_MAP[ext] || 'image/png';
    let buf = (await fs.promises.readFile(filePath)) as Buffer;
    let outMime = mime;
    if (buf.length > 500 * 1024) {
      const result = await compressImageIfLarge(buf, mime);
      if (result.compressed) { buf = result.buffer; outMime = result.mime; }
    }
    const data = buf.toString('base64');
    const id = imageStore.store(data, outMime, filePath);
    return { id, data, media_type: outMime };
  } catch {
    return null;
  }
}

// ── view_image 工具 ──────────────────────────────────────────────────

/**
 * 视觉能力不足时的统一告知（2026-11-21）。
 *
 * 背景（摩擦清单第 1 条）：`view_image` 曾经无条件回「will be visible in the next response」，
 * 而 context 阶段 `if (pending.length > 0 && vision)` 在 **vision=false 时直接跳过**，
 * 调用方随后又无条件 `pendingImageInjections.length = 0` ⇒ 图被静默丢弃，
 * 我（agent）以为看到了、其实整轮靠用户文字瞎猜。
 * 现在三层同一边界：工具层先查能力并**显式拒绝**，context 层兜底落 MediaDropped 标记。
 * ⚠️ 这里的措辞要与 `orchestrator/stages/context.ts` 的 `droppedMarker` 保持一致。
 */
export function imageNotDeliveredNotice(imgId: string, model?: string): string {
  return (
    `[Image #${imgId} NOT DELIVERED] 当前模型${model ? `（${model}）` : ''}不支持图像输入（vision=false）` +
    `⇒ 图**没有**送进上下文，你看不到它。图仍在索引里：换到视觉模型后可再次 view_image("${imgId}")，` +
    `否则请让用户用文字描述内容。`
  );
}

/** view_image 的运行时能力注入（缺省 = 保持旧行为「支持」，仅测试/老装配不传） */
export interface ViewImageOptions {
  /** 本轮实际发送的模型是否支持图像输入 */
  getVisionSupport?: () => boolean;
  /** 仅用于告知文案 */
  getModelLabel?: () => string;
}

/**
 * 2026-11-21 活体实验发现：`pendingInjections` 的**每一项都必须带 origin**。
 *
 * 事故（当场复现，不是推测）：调 `view_image("C:\...\avatar-v5.png")`，工具回
 * "will be visible in the next response"，下一轮**确实看到了图**；但落盘的
 * MediaStripped 标记写的是「来源未记录（可能是渠道附图）—— 需要时请重发」。
 * 原因：路径分支 push 时只塞了 `{imgId, data, media_type}`，丢了来源；
 * 而 `ImageStore.store()` 明明把 source_path 存下来了。后果：历史里那条标记无法回溯，
 * 下一轮的我只能读到"来源未记录"，误判成"图没送达"（摩擦清单第 1 条的原始症状）。
 */
export function createViewImageTool(
  imageStore: ImageStore,
  pendingInjections: Array<{ imgId: string; data: string; media_type: string; origin?: string }>,
  opts: ViewImageOptions = {},
) {
  return {
    name: 'view_image',
    description: 'View an image: pass an indexed image ID (e.g. "img_001"), OR a local image file path (generated file / user file) — paths are auto-read, compressed and injected into context on the next turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        image_id: { type: 'string' as const, description: 'The image ID to re-examine (e.g. "img_001")' },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const imgId = String(args.image_id || '').trim();
      if (!imgId || imgId === 'list' || imgId === 'all') {
        const entries = imageStore.list();
        if (entries.length === 0) return 'No images indexed yet.';
        return entries.map(e => {
          const sizeStr = e.byteSize < 1024 ? `${e.byteSize}B` : `${(e.byteSize / 1024).toFixed(1)}KB`;
          const desc = e.description ? ` — ${e.description.slice(0, 150)}` : '';
          return `#${e.id}: ${e.media_type.split('/')[1]?.toUpperCase() || 'IMG'}, ${sizeStr}${desc} (from ${e.source_path || 'unknown'})`;
        }).join('\n');
      }
      const img = imageStore.get(imgId);
      // 能力闸门：vision=false 时**不注入**、也不回「will be visible」——否则图被 context 阶段静默丢弃，
      // 而我以为看到了（见 imageNotDeliveredNotice 注释）。图仍留在 imageStore，换模型后可再取。
      const visionOk = opts.getVisionSupport?.() ?? true;
      if (!img) {
        // 路径回看：生成产物 / 用户图片文件 → 读取+压缩+索引+注入（P2 多模态）
        const loaded = await loadImageFileToStore(imgId, imageStore);
        if (loaded) {
          if (!visionOk) {
            return `[Image #${loaded.id} indexed from ${imgId}]\n`
              + imageNotDeliveredNotice(loaded.id, opts.getModelLabel?.());
          }
          // ⚠️ origin 必须带上（2026-11-21 实测）：漏了它，落盘的 MediaStripped 就成「来源未记录」，
          // 下一轮的我读到后误判成"图没送达"。此处来源就是调用方给的路径（imgId 此时是路径）。
          pendingInjections.push({ imgId: loaded.id, data: loaded.data, media_type: loaded.media_type, origin: imgId });
          const ext = loaded.media_type.split('/')[1]?.toUpperCase() || 'IMG';
          const sizeStr = loaded.data.length < 700 ? `${loaded.data.length}B` : `${(loaded.data.length / 700).toFixed(1)}KB`;
          return `[Image #${loaded.id} loaded from ${imgId}: ${ext}, ${sizeStr}]
The image will be visible in the next response.`;
        }
        const available = imageStore.list().map(i => i.id).join(', ') || '(none)';
        return `Image #${imgId} not found (也不是可读取的本地图片路径). Available images: ${available}`;
      }
      if (!visionOk) return imageNotDeliveredNotice(imgId, opts.getModelLabel?.());
      // 同上：origin 从索引里取回（store() 时记过 source_path）
      pendingInjections.push({ imgId, data: img.data, media_type: img.media_type, origin: img.source_path || undefined });
      const sizeStr = img.byteSize < 1024 ? `${img.byteSize}B` : `${(img.byteSize / 1024).toFixed(1)}KB`;
      const desc = img.description ? ` — ${img.description.slice(0, 200)}` : '';
      return `[Image #${imgId} retrieved: ${img.media_type.split('/')[1]?.toUpperCase() || 'IMG'}, ${sizeStr}${desc}]\nThe image will be visible in the next response.`;
    },
  };
}

// ── view_media 工具（图片/视频/音频统一查看，P2 多模态）──────────────

/** view_media 执行时解析的能力/阈值（支持运行时 provider 切换） */
export interface ViewMediaOptions {
  getInputTypes?: () => string[] | undefined;
  /** 视觉能力（图片分支的闸门，2026-11-21 与 view_image 同一语义；缺省视为支持） */
  getVisionSupport?: () => boolean;
  /** 仅用于「未送达」告知文案 */
  getModelLabel?: () => string;
  getVideoInlineMaxBytes?: () => number | undefined;
  getVideoMaxFrames?: () => number | undefined;
  getAudioInlineMaxBytes?: () => number | undefined;
}

export function createViewMediaTool(
  imageStore: ImageStore,
  pendingImageInjections: Array<{ imgId: string; data: string; media_type: string; origin?: string }>,
  pendingMediaInjections: Array<{ type: 'video' | 'audio'; media_type: string; data: string; origin?: string }>,
  opts: ViewMediaOptions = {},
) {
  return {
    name: 'view_media',
    description:
      '查看本地媒体文件并注入下一轮上下文。传图片路径或图片 ID（img_001）→ 直接注入；传视频（mp4/webm/mov）→ 模型支持原生视频且未超限则原生注入，否则 ffmpeg 抽帧成图片；传音频（mp3/wav/m4a）→ 模型支持原生音频则原生注入。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        media_path: {
          type: 'string' as const,
          description: '本地媒体文件路径（png/jpg/gif/mp4/webm/mov/mp3/wav/m4a…）或已索引图片 ID（img_001）',
        },
        capture: {
          type: 'string' as const,
          description:
            '抓源(免另跑截图命令)：`window:<标题片段>` 抓指定窗口(自动恢复最小化+置前台再 BitBlt，如 window:Google Chrome)；`camera` 抓摄像头一帧(需 ffmpeg)。给了 capture 则 media_path 可省，抓到的 PNG 走同一注入路径。',
        },
      },
      required: [], // media_path 或 capture 二选一（execute 里校验）
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      // 视觉能力闸门（2026-11-21，与 view_image 同一语义）：vision=false 时图片注入会被
      // context 阶段静默丢弃 ⇒ 这里必须如实回报「没送进去」，否则我会以为看到了。
      const visionOk = opts.getVisionSupport?.() ?? true;
      const captureSpec = String(args.capture || '').trim();
      if (captureSpec) {
        // 抓源：base64 直接进内存 imageStore，全程不落盘。
        const cap = await runCapture(captureSpec);
        if (cap.error) return cap.error;
        const b64 = cap.base64!;
        const imgId = imageStore.store(b64, 'image/png', captureSpec);
        if (!visionOk) {
          return `[Image #${imgId} captured from ${captureSpec}]\n`
            + imageNotDeliveredNotice(imgId, opts.getModelLabel?.());
        }
        pendingImageInjections.push({ imgId, data: b64, media_type: 'image/png', origin: captureSpec });
        return `[Image #${imgId} captured from ${captureSpec}]\nThe image will be visible in the next response.`;
      }
      let target = String(args.media_path || '').trim();
      if (!target) return 'Error: media_path 或 capture 至少给一个';
      const ext = path.extname(target).toLowerCase().replace('.', '');

      // 图片：ID 或路径（复用 view_image 语义）
      if (imageStore.get(target) || IMAGE_MIME_MAP[ext]) {
        const img = imageStore.get(target);
        if (img) {
          if (!visionOk) return imageNotDeliveredNotice(target, opts.getModelLabel?.());
          pendingImageInjections.push({ imgId: target, data: img.data, media_type: img.media_type, origin: img.source_path || undefined });
          return `[Image #${target} retrieved]\nThe image will be visible in the next response.`;
        }
        const loaded = await loadImageFileToStore(target, imageStore);
        if (loaded) {
          // 抓源临时文件用完即删（摄像头帧/窗口截图不留在盘上，防累积 + 隐私）。只删本工具产出的 hyacinth-cam-/hyacinth-capture-。
          const bn = path.basename(target);
          if (bn.startsWith('hyacinth-cam-') || bn.startsWith('hyacinth-capture-')) {
            try { fs.unlinkSync(target); } catch { /* ignore */ }
          }
          if (!visionOk) {
            return `[Image #${loaded.id} indexed from ${target}]\n`
              + imageNotDeliveredNotice(loaded.id, opts.getModelLabel?.());
          }
          pendingImageInjections.push({ imgId: loaded.id, data: loaded.data, media_type: loaded.media_type, origin: target });
          return `[Image #${loaded.id} loaded from ${target}]\nThe image will be visible in the next response.`;
        }
        return `Error: 无法读取图片 ${target}`;
      }

      // 视频：原生注入（能力 + 未超限）→ 否则抽帧成图片
      if (VIDEO_MIME_MAP[ext]) {
        try {
          const stat = fs.statSync(target);
          const supportsVideo = opts.getInputTypes?.()?.includes('video') ?? false;
          const inlineMax = opts.getVideoInlineMaxBytes?.() ?? DEFAULT_VIDEO_INLINE_MAX;
          if (supportsVideo && stat.size <= inlineMax) {
            const data = (await fs.promises.readFile(target)).toString('base64');
            pendingMediaInjections.push({ type: 'video', media_type: VIDEO_MIME_MAP[ext], data, origin: target });
            return `[Video queued for native injection: ${target}]\nThe video will be visible in the next response (model supports video input).`;
          }
          const frames = await extractFrames(target, {
            fps: 1,
            max_frames: opts.getVideoMaxFrames?.() ?? DEFAULT_VIDEO_MAX_FRAMES,
            max_long_side_pixel: 1024,
          });
          if (frames.length === 0) {
            return `[Video file: ${target} — 模型不支持原生视频且无法抽帧（ffmpeg 不可用），需先转成图片]`;
          }
          let count = 0;
          for (const frame of frames) {
            let buf = frame;
            let outMime = 'image/png';
            if (buf.length > LARGE_IMAGE_BYTES) {
              const comp = await compressImageIfLarge(buf, 'image/png');
              if (comp.compressed) { buf = comp.buffer; outMime = comp.mime; }
            }
            const b64 = buf.toString('base64');
            const imgId = imageStore.store(b64, outMime, target);
            pendingImageInjections.push({ imgId, data: b64, media_type: outMime, origin: target + '（视频抽帧 ' + (count + 1) + '/' + frames.length + '）' });
            count++;
          }
          return `[Video ${target} → ${count} frames extracted as images]\nThe frames will be visible in the next response.`;
        } catch (err) {
          return `Error viewing video: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // 音频：原生注入（能力 + 未超限）→ 否则占位
      if (AUDIO_MIME_MAP[ext]) {
        try {
          const stat = fs.statSync(target);
          const supportsAudio = opts.getInputTypes?.()?.includes('audio') ?? false;
          const inlineMax = opts.getAudioInlineMaxBytes?.() ?? DEFAULT_AUDIO_INLINE_MAX;
          if (supportsAudio && stat.size <= inlineMax) {
            const data = (await fs.promises.readFile(target)).toString('base64');
            pendingMediaInjections.push({ type: 'audio', media_type: AUDIO_MIME_MAP[ext], data, origin: target });
            return `[Audio queued for native injection: ${target}]\nThe audio will be visible in the next response (model supports audio input).`;
          }
          return `[Audio file: ${target}]`;
        } catch (err) {
          return `Error viewing audio: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return `Error: 不支持的媒体格式 ${target}`;
    },
  };
}
