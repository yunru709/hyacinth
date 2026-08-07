/**
 * GenerateVideoTool — 主 agent 通用视频生成工具。
 *
 * 链路：LLM 调用 → 本工具 → GenerationService.generate() → 适配器 → 落盘 ~/.agent/generation/
 *
 * 与 GenerateImageTool 同构，但 taskType 按输入自动选择：
 * - 有参考视频 → reference_to_video（Seedance 多模态参考）
 * - 有参考图（且无参考视频）→ image_to_video
 * - 否则 → text_to_video
 *
 * 视频是异步任务（分钟级），service 内部自动轮询（默认 15s 间隔），
 * 工具层不感知轮询细节，只等最终产物。
 *
 * 参数（面向 LLM 精简）：
 * - prompt: 正向提示词（必填）
 * - duration: 视频时长秒数（可选，默认按模型，Seedance 上限 15s）
 * - resolution: '480p'|'720p'|'1080p'|'4k'（可选）
 * - aspect_ratio: 宽高比（可选）
 * - reference_images: 参考图 URL 数组（首帧/图生视频）
 * - reference_videos: 参考视频 URL 数组（多模态参考，Seedance 2.0）
 * - generate_audio: 是否生成音频（可选）
 * - provider: 供应商（可选，默认取该任务类型的默认供应商）
 */

import type { Tool } from './interface.js';
import { recordMediaFile } from '../media/index.js';

export class GenerateVideoTool implements Tool {
  readonly name = 'generate_video';
  readonly description =
    '生成视频。prompt 必填（正向提示词），可选 duration（秒）、resolution（480p/720p/1080p/4k）、aspect_ratio（宽高比）、reference_images（参考图，图生视频）、reference_videos（参考视频）、generate_audio（是否生成音频）。视频为异步任务，生成后保存到本地并返回路径。';

  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '正向提示词，描述视频内容',
      },
      duration: {
        type: 'number',
        description: '视频时长（秒），Seedance 上限 15 秒',
      },
      resolution: {
        type: 'string',
        enum: ['480p', '720p', '1080p', '4k'],
        description: '分辨率档位，默认按模型',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        description: '宽高比（可选，适配器按厂商支持映射）',
      },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图 URL 列表（首帧/图生视频用，可选）',
      },
      reference_videos: {
        type: 'array',
        items: { type: 'string' },
        description: '参考视频 URL 列表（多模态参考，仅 Seedance 2.0，可选）',
      },
      generate_audio: {
        type: 'boolean',
        description: '是否生成同步音频（可选）',
      },
      provider: {
        type: 'string',
        description: '生成供应商名（可选，默认取该任务类型的默认供应商）',
      },
    },
    required: ['prompt'],
  };

  private cwd: string;
  private outputDir?: string;
  private pollIntervalMs?: number;
  private mediaDbPath?: string;

  constructor(cwd?: string, outputDir?: string, pollIntervalMs?: number, mediaDbPath?: string) {
    this.cwd = cwd ?? process.cwd();
    this.outputDir = outputDir;
    this.pollIntervalMs = pollIntervalMs;
    this.mediaDbPath = mediaDbPath;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return 'Error: prompt is required.';

    // 懒加载 generation 模块
    let GenerationRegistry: typeof import('../generation/index.js').GenerationRegistry;
    let GenerationService: typeof import('../generation/index.js').GenerationService;
    try {
      const mod = await import('../generation/index.js');
      GenerationRegistry = mod.GenerationRegistry;
      GenerationService = mod.GenerationService;
    } catch (err) {
      return `Error: generation module unavailable: ${(err as Error).message}`;
    }

    // 构建 registry + service
    let registry: InstanceType<typeof GenerationRegistry>;
    try {
      registry = GenerationRegistry.load(this.cwd);
    } catch (err) {
      return `Error: failed to load generation config: ${(err as Error).message}`;
    }

    // 输入 → taskType
    const refVideos = Array.isArray(args.reference_videos)
      ? (args.reference_videos as string[]).map(u => ({ type: 'url' as const, url: String(u), role: 'reference_video' as const }))
      : undefined;
    const refImages = Array.isArray(args.reference_images)
      ? (args.reference_images as string[]).map(u => ({ type: 'url' as const, url: String(u), role: 'first_frame' as const }))
      : undefined;
    const taskType = refVideos && refVideos.length > 0
      ? 'reference_to_video'
      : refImages && refImages.length > 0
        ? 'image_to_video'
        : 'text_to_video';

    // 未指定供应商时，用该任务类型的默认供应商名；都没有则报错并给指引
    const provider = args.provider ? String(args.provider) : undefined;
    let providerName: string | null = provider ?? null;
    if (!providerName) {
      providerName = registry.getDefaultProviderName(taskType);
      if (!providerName) {
        return (
          'Error: no video generation provider configured.\n' +
          'Set up .agent/generation.json:\n' +
          '{\n' +
          '  "providers": { "volc": { "type": "volcengine", "models": { "text_to_video": "doubao-seedance-2-0" }, "apiKeyEnv": "ARK_API_KEY" } },\n' +
          '  "defaults": { "text_to_video": "volc" }\n' +
          '}\n' +
          'And set ARK_API_KEY environment variable.'
        );
      }
    }

    const service = new GenerationService(registry, this.cwd);
    try {
      const artifact = await service.generate(
        {
          provider: providerName,
          taskType,
          prompt,
          duration: args.duration !== undefined ? Number(args.duration) : undefined,
          resolution: args.resolution ? String(args.resolution) : undefined,
          aspectRatio: args.aspect_ratio ? String(args.aspect_ratio) : undefined,
          referenceImages: refImages,
          referenceVideos: refVideos,
          generateAudio: args.generate_audio !== undefined ? Boolean(args.generate_audio) : undefined,
        },
        // 未显式指定 outputDir 时，service 默认落 ~/.agent/generation（用户运行环境）
        this.outputDir || this.pollIntervalMs
          ? { outputDir: this.outputDir, ...(this.pollIntervalMs ? { pollIntervalMs: this.pollIntervalMs } : {}) }
          : {},
      );

      if (!artifact.localPath) {
        return `Generated (remote only): ${artifact.sourceUrl}`;
      }

      // 归档到媒体库（独立 media.sqlite；失败不阻断主流程）
      recordMediaFile(
        artifact.localPath,
        { type: 'video', source: 'generation', taskType, prompt },
        this.mediaDbPath,
      );

      return (
        `Video generated and saved to ${artifact.localPath}\n` +
        `Provider: ${artifact.provider} | Size: ${artifact.byteSize} bytes | Media: ${artifact.mediaType}\n` +
        (artifact.duration ? `Duration: ${artifact.duration}s\n` : '') +
        `Source URL: ${artifact.sourceUrl}`
      );
    } catch (err) {
      return `Error generating video: ${(err as Error).message}`;
    }
  }
}
