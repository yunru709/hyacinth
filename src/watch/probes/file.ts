/**
 * file probe（2026-10-29）
 *
 * 指纹语义：
 *   - 文件不存在 → value='missing'（**这是合法状态，不是错误**）
 *     这样「等文件出现」= missing → sha1，能被正常识别为变化。
 *   - 读取失败（权限/占用）→ ok=false，上层不当成"变化"
 *
 * content 模式取「size + 头 64KB + 尾 64KB」的 sha1：
 * 对"写了一半"敏感，又不必把几百 MB 的文件整个读进来。
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import type { FileSpec, Probe, ProbeInstance, ProbeSample } from '../types.js';

const HEAD_TAIL = 64 * 1024;

async function contentFingerprint(filePath: string): Promise<string> {
  const st = await stat(filePath);
  const size = st.size;
  const hash = createHash('sha1');
  hash.update(`size:${size};`);

  if (size === 0) return hash.digest('hex');

  const fh = await open(filePath, 'r');
  try {
    const headLen = Math.min(HEAD_TAIL, size);
    const head = Buffer.alloc(headLen);
    const headRead = await fh.read(head, 0, headLen, 0);
    hash.update(head.subarray(0, headRead.bytesRead));

    if (size > HEAD_TAIL * 2) {
      const tail = Buffer.alloc(HEAD_TAIL);
      const tailRead = await fh.read(tail, 0, HEAD_TAIL, size - HEAD_TAIL);
      hash.update(tail.subarray(0, tailRead.bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

class FileProbeInstance implements ProbeInstance {
  constructor(private readonly spec: FileSpec) {}

  async sample(signal?: AbortSignal): Promise<ProbeSample> {
    if (signal?.aborted) return { ok: false, value: '', error: 'aborted' };
    const mode = this.spec.watch ?? 'content';
    try {
      if (mode === 'mtime') {
        const st = await stat(this.spec.path);
        return { ok: true, value: `${st.size}:${Math.floor(st.mtimeMs)}`, raw: { size: st.size, mtimeMs: st.mtimeMs } };
      }
      return { ok: true, value: await contentFingerprint(this.spec.path) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 不存在是正常状态：等待文件出现就靠它
        return { ok: true, value: 'missing' };
      }
      return { ok: false, value: '', error: `${code ?? 'ERROR'}: ${(err as Error).message}` };
    }
  }
}

export const fileProbe: Probe = {
  kind: 'file',
  description: '文件出现 / 内容变化 / 修改时间变化（watch=content|mtime）',
  create(spec) {
    if (spec.kind !== 'file') throw new Error('fileProbe received mismatched spec');
    if (!spec.path || typeof spec.path !== 'string') throw new Error('file probe requires a path');
    if (spec.watch && spec.watch !== 'content' && spec.watch !== 'mtime') {
      throw new Error("file probe: watch must be 'content' or 'mtime'");
    }
    return new FileProbeInstance(spec);
  },
};
