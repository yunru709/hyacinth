/**
 * 多模态/图片管线 — 用户输入图片检测、压缩、索引、回收
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MessageContent } from '../types.js';
import { extractFrames } from './ffmpeg.js';
import { recordMediaFile } from '../media/index.js';

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

  private _contentHash(base64Data: string, mediaType: string): string {
    const head = base64Data.slice(0, 512);
    const tail = base64Data.slice(-512);
    return `${mediaType}:${base64Data.length}:${head.length}:${tail.length}`;
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

export function createViewImageTool(imageStore: ImageStore, pendingInjections: Array<{ imgId: string; data: string; media_type: string }>) {
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
      if (!img) {
        // 路径回看：生成产物 / 用户图片文件 → 读取+压缩+索引+注入（P2 多模态）
        const loaded = await loadImageFileToStore(imgId, imageStore);
        if (loaded) {
          pendingInjections.push({ imgId: loaded.id, data: loaded.data, media_type: loaded.media_type });
          const ext = loaded.media_type.split('/')[1]?.toUpperCase() || 'IMG';
          const sizeStr = loaded.data.length < 700 ? `${loaded.data.length}B` : `${(loaded.data.length / 700).toFixed(1)}KB`;
          return `[Image #${loaded.id} loaded from ${imgId}: ${ext}, ${sizeStr}]
The image will be visible in the next response.`;
        }
        const available = imageStore.list().map(i => i.id).join(', ') || '(none)';
        return `Image #${imgId} not found (也不是可读取的本地图片路径). Available images: ${available}`;
      }
      pendingInjections.push({ imgId, data: img.data, media_type: img.media_type });
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
      },
      required: ['media_path'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const target = String(args.media_path || '').trim();
      if (!target) return 'Error: media_path 不能为空';
      const ext = path.extname(target).toLowerCase().replace('.', '');

      // 图片：ID 或路径（复用 view_image 语义）
      if (imageStore.get(target) || IMAGE_MIME_MAP[ext]) {
        const img = imageStore.get(target);
        if (img) {
          pendingImageInjections.push({ imgId: target, data: img.data, media_type: img.media_type, origin: img.source_path || undefined });
          return `[Image #${target} retrieved]\nThe image will be visible in the next response.`;
        }
        const loaded = await loadImageFileToStore(target, imageStore);
        if (loaded) {
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
