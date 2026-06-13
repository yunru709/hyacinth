/**
 * 多模态/图片管线 — 用户输入图片检测、压缩、索引、回收
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MessageContent } from '../types.js';

// ── MIME 映射 ───────────────────────────────────────────────────────

export const IMAGE_MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
};

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
    // @ts-expect-error — sharp 0.35 types incompatible with pnpm exports
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

export function detectImagePaths(text: string): string[] {
  const paths: string[] = [];
  // Match paths with image extensions. Allows spaces (stops at quotes/newlines).
  // Windows: C:\..., Unix: /..., Relative: ./... or ../...
  const pathRegex = /(?:["'`])?((?:[A-Za-z]:[^"'\n\r]*|(?:\/|\.\.?\/)[^"'\n\r]*)\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tiff?))(?:["'`])?/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(text)) !== null) {
    const p = match[1]!;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) paths.push(p);
  }
  return paths;
}

// ── 构建带图片的用户消息（渠道预取 inline base64）───────────────────

/** 渠道图片：接受已下载的 base64 数据，直接构造 ImageContent */
export function buildUserContentWithInlineImages(
  userInput: string,
  images: Array<{ data: string; media_type: string }>,
  imageStore: ImageStore,
): MessageContent | MessageContent[] {
  if (images.length === 0) return { type: 'text', text: userInput };

  const blocks: MessageContent[] = [];
  for (const img of images) {
    const imgId = imageStore.store(img.data, img.media_type);
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    const ext = img.media_type.split('/')[1]?.toUpperCase() || 'IMG';
    const sizeStr = img.data.length < 700 ? `${img.data.length}B` : `${(img.data.length / 700).toFixed(1)}KB`;
    blocks.push({ type: 'text', text: `[Image indexed as #${imgId}: ${ext}, ${sizeStr}]` });
  }
  blocks.push({ type: 'text', text: userInput });
  return blocks;
}

// ── 构建带图片的用户消息（本地磁盘路径）─────────────────────────────

export async function buildUserContentWithImages(
  userInput: string, imageStore: ImageStore,
): Promise<MessageContent | MessageContent[]> {
  const imagePaths = detectImagePaths(userInput);
  if (imagePaths.length === 0) return { type: 'text', text: userInput };

  const blocks: MessageContent[] = [];
  const LARGE_BYTES = 500 * 1024;

  for (const imgPath of imagePaths) {
    const ext = path.extname(imgPath).toLowerCase().replace('.', '');
    const mime = IMAGE_MIME_MAP[ext] || 'image/png';
    try {
      const stat = fs.statSync(imgPath);
      let buf = (await fs.promises.readFile(imgPath)) as Buffer;
      let outMime = mime;

      if (buf.length > LARGE_BYTES) {
        const result = await compressImageIfLarge(buf, mime);
        if (result.compressed) {
          buf = result.buffer;
          outMime = result.mime;
        }
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
  blocks.push({ type: 'text', text: userInput });
  return blocks;
}

// ── view_image 工具 ──────────────────────────────────────────────────

export function createViewImageTool(imageStore: ImageStore, pendingInjections: Array<{ imgId: string; data: string; media_type: string }>) {
  return {
    name: 'view_image',
    description: 'Re-examine a previously indexed image by its ID (e.g. "img_001"). Use this when you need to look at an image again for more details. The image will be injected into context on the next turn.',
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
        const available = imageStore.list().map(i => i.id).join(', ') || '(none)';
        return `Image #${imgId} not found. Available images: ${available}`;
      }
      pendingInjections.push({ imgId, data: img.data, media_type: img.media_type });
      const sizeStr = img.byteSize < 1024 ? `${img.byteSize}B` : `${(img.byteSize / 1024).toFixed(1)}KB`;
      const desc = img.description ? ` — ${img.description.slice(0, 200)}` : '';
      return `[Image #${imgId} retrieved: ${img.media_type.split('/')[1]?.toUpperCase() || 'IMG'}, ${sizeStr}${desc}]\nThe image will be visible in the next response.`;
    },
  };
}
