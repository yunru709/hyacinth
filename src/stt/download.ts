/**
 * STT 模型下载 — 多源直链 + 进度回调。
 *
 * 为什么不用 local-model/DownloadManager：那是 llama.cpp release 专用（整包下载 +
 * 解包落位）；SenseVoice 只需要两个散装单文件（model.int8.onnx / tokens.txt），
 * 从 hf-mirror / huggingface 直链拿即可，量级和逻辑都更轻。
 *
 * 多源顺序尝试：hf-mirror（国内可达）→ huggingface 官方。断点续传不做
 * （230MB 单文件，失败整文件重下，进度事件让 UI 可见即可）。
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('stt-download');

export interface DownloadProgress {
  percent: number;
  received: number;
  total: number;
  speed: string;
}

export class ModelDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

/** 下载单文件到 dest（先写 .part 再改名，避免半截文件被当成就绪）。 */
export function downloadFile(urls: string[], dest: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let urlIndex = 0;
    const tryNext = (): void => {
      if (urlIndex >= urls.length) {
        reject(new ModelDownloadError(`所有下载源均失败（${urls.length} 个源）`));
        return;
      }
      const url = urls[urlIndex++];
      fetchOne(url, dest, onProgress).then(resolve).catch((err) => {
        logger.warn(`下载源失败（${new URL(url).host}）：${err instanceof Error ? err.message : err}`);
        tryNext();
      });
    };
    tryNext();
  });
}

function fetchOne(url: string, dest: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const started = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': 'hyacinth-stt-downloader/1.0' }, timeout: 30000 }, (res) => {
      // 3xx 跟随（hf-mirror 会 302 到 CDN）
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchOne(new URL(res.headers.location, url).href, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new ModelDownloadError(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastEmit = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastEmit > 500) {
          lastEmit = now;
          const sec = Math.max(0.5, (now - started) / 1000);
          onProgress({
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
            received,
            total,
            speed: `${(received / 1024 / 1024 / sec).toFixed(1)} MB/s`,
          });
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ModelDownloadError('下载超时')));
    req.on('error', reject);
  });
}
