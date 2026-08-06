/**
 * GenerationService — 生成供应商门面。
 *
 * 高层封装 generate()：提交任务 → 轮询状态 → 下载转存 → 返回本地产物。
 * 与对话 Provider 的"流式推理"并列——生成是"一次请求 → 一个产物"。
 *
 * 职责：
 * - 路由到指定/默认供应商
 * - 内部统一轮询（适配器只做请求/状态映射，不负责轮询）
 * - 结果下载转存到 outputs/generation/
 * - 反喂 ImageStore（可选，供 view_image 重看）
 *
 * 轮询参数按模态差异化：图片可快轮询，视频慢轮询（分钟级任务）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { GenerationRegistry } from './registry.js';
import type {
  GeneratedArtifact,
  GenerationTaskType,
  GenerationRequest,
  GenerationStatus,
  GenerationTask,
  GenerationProvider,
} from './interface.js';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const VIDEO_POLL_INTERVAL_MS = 15000;
const MAX_POLL_ATTEMPTS = 600; // 15s * 600 = 2.5h 上限（视频长任务）

export interface GenerateOptions {
  /** 轮询间隔（毫秒），不传则按任务类型自动选择 */
  pollIntervalMs?: number;
  /** 最大轮询次数 */
  maxAttempts?: number;
  /** 是否下载转存（默认 true） */
  download?: boolean;
  /** 输出目录（默认 <cwd>/outputs/generation） */
  outputDir?: string;
  /** 完成后回调（可用于通知前端/渠道） */
  onStatus?: (status: { status: GenerationStatus; progress?: number }) => void;
}

export class GenerationService {
  private registry: GenerationRegistry;
  private cwd: string;

  constructor(registry: GenerationRegistry, cwd: string) {
    this.registry = registry;
    this.cwd = cwd;
  }

  /** 手动指定供应商 */
  getProvider(name: string): GenerationProvider {
    return this.registry.getProvider(name);
  }

  /** 按任务类型取默认供应商 */
  getDefaultProvider(taskType: GenerationTaskType) {
    return this.registry.getDefaultProvider(taskType);
  }

  /**
   * 高层生成入口：提交 + 轮询 + 转存。
   * 返回本地落盘产物；失败抛错（含厂商原始错误信息）。
   */
  async generate(req: GenerationRequest, opts: GenerateOptions = {}): Promise<GeneratedArtifact> {
    const provider = this.registry.getProvider(req.provider);

    // 1. 提交任务（同步供应商会直接填充 initialStatus）
    const task = await provider.submitTask(req);

    // 2. 同步完成（图片等同步接口）→ 直接进入转存，跳过轮询
    if (task.initialStatus) {
      if (task.initialStatus.status === 'success') {
        opts.onStatus?.({ status: 'success' });
        return await this.finalize(task.initialStatus, provider, task, req, opts);
      }
      if (task.initialStatus.status === 'failed') {
        throw new Error(
          `generation task ${task.taskId} failed: ${task.initialStatus.errorCode || ''} ${task.initialStatus.errorMessage || ''}`.trim(),
        );
      }
      // 其他状态理论上同步接口不会返回，落到下方轮询兜底
    }

    opts.onStatus?.({ status: 'queuing' });

    // 3. 异步任务 → 轮询状态
    const status = await this.pollUntilDone(provider, task, req, opts);

    // 4. 下载转存
    return await this.finalize(status, provider, task, req, opts);
  }

  // ── 内部：轮询 ────────────────────────────────────────────────────

  private async pollUntilDone(
    provider: GenerationProvider,
    task: GenerationTask,
    req: GenerationRequest,
    opts: GenerateOptions,
  ): Promise<NonNullable<Awaited<ReturnType<GenerationProvider['getTaskStatus']>>>> {
    const interval = opts.pollIntervalMs ?? (req.taskType.startsWith('text_to_video') || req.taskType.startsWith('image_to_video') || req.taskType.startsWith('reference_to_video')
      ? VIDEO_POLL_INTERVAL_MS
      : DEFAULT_POLL_INTERVAL_MS);
    const maxAttempts = opts.maxAttempts ?? MAX_POLL_ATTEMPTS;

    for (let i = 0; i < maxAttempts; i++) {
      // 支持中断
      if (req.signal?.aborted) {
        throw new Error(`generation task ${task.taskId} aborted by signal`);
      }

      const status = await provider.getTaskStatus(task);
      opts.onStatus?.({ status: status.status, progress: status.progress });

      switch (status.status) {
        case 'success':
          if (!status.resultUrl) {
            throw new Error(`generation task ${task.taskId} succeeded but no resultUrl returned`);
          }
          return status;
        case 'failed':
          throw new Error(
            `generation task ${task.taskId} failed: ${status.errorCode || ''} ${status.errorMessage || ''}`.trim(),
          );
        case 'canceled':
        case 'expired':
          throw new Error(`generation task ${task.taskId} ${status.status}`);
        default:
          // queuing / processing：继续轮询
          break;
      }

      await sleep(interval);
    }

    throw new Error(`generation task ${task.taskId} timed out after ${maxAttempts} polls`);
  }

  // ── 内部：结果定稿（转存 / 仅 URL 引用）─────────────────────────

  private async finalize(
    status: NonNullable<Awaited<ReturnType<GenerationProvider['getTaskStatus']>>>,
    provider: GenerationProvider,
    task: GenerationTask,
    req: GenerationRequest,
    opts: GenerateOptions,
  ): Promise<GeneratedArtifact> {
    const caps = provider.getCapabilities();
    const defaultMediaType = caps.outputFormats[0];

    // 只返回 URL 引用，不落盘（调用方自行处理）
    if (opts.download === false) {
      return {
        localPath: '',
        sourceUrl: status.resultUrl || '',
        mediaType: defaultMediaType || 'application/octet-stream',
        byteSize: 0,
        provider: task.provider,
        model: req.model || '',
        createdAt: new Date().toISOString(),
      };
    }

    if (!status.resultUrl) {
      throw new Error(`generation task ${task.taskId} has no resultUrl`);
    }

    const outputDir = opts.outputDir ?? path.join(this.cwd, 'outputs', 'generation');
    fs.mkdirSync(outputDir, { recursive: true });

    const url = status.resultUrl;
    const ext = this.guessExtension(url, defaultMediaType);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${task.taskId || 'gen'}_${stamp}.${ext}`;
    const localPath = path.join(outputDir, filename);

    const buf = await this.download(url, req.signal);
    fs.writeFileSync(localPath, buf);

    const mediaType = this.guessMediaType(ext, defaultMediaType);
    return {
      localPath,
      sourceUrl: url,
      mediaType,
      byteSize: buf.length,
      width: status.resultWidth,
      height: status.resultHeight,
      duration: status.duration,
      provider: task.provider,
      model: req.model || '',
      createdAt: new Date().toISOString(),
    };
  }

  private async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  }

  // ── 内部：文件类型推断 ────────────────────────────────────────────

  private guessExtension(url: string, fallback?: string): string {
    try {
      const clean = url.split('?')[0] || '';
      const m = clean.match(/\.([a-zA-Z0-9]+)$/);
      if (m) return m[1]!.toLowerCase();
    } catch { /* ignore */ }
    if (fallback) {
      const m2 = fallback.split('/')[1];
      if (m2) return m2.toLowerCase();
    }
    return 'bin';
  }

  private guessMediaType(ext: string, fallback?: string): string {
    const map: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    };
    return map[ext] || fallback || 'application/octet-stream';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
