import fs from 'node:fs';
import path from 'node:path';
import type { DownloadProgress } from './types.js';

export async function downloadWithProgress(
  url: string,
  destDir: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, 'release.zip');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    if (contentLength > 0) {
      onProgress({ percent: Math.round((downloaded / contentLength) * 100), downloaded, total: contentLength });
    }
  }

  const buf = Buffer.concat(chunks);
  fs.writeFileSync(zipPath, buf);
  return zipPath;
}
