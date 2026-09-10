/**
 * GenerateMediaTool — 主 agent 统一多模态生成工具（合并原 generate_image + generate_video）。
 *
 * 链路：LLM 调用 → 本工具 → GenerationService.generate() → 适配器 → 落盘 ~/.agent/generation/
 *
 * 设计要点：
 * - modality（image/video/audio）必填，做顶层分流
 * - taskType 按参考媒体自动推断（沿用原两工具逻辑）：
 *     image  + reference_images → image_to_image；否则 text_to_image
 *     video  + reference_videos → reference_to_video
 *     video  + reference_images → image_to_video（首帧）
 *     video  否则              → text_to_video
 *     audio                     → audio_tts
 * - 懒加载 generation 模块（避免 tools → generation 循环依赖）
 * - 公开全部参数（首尾帧/参考音频/seed/voice/speed 等此前隐藏的能力）
 * - 生成结果返回本地落盘路径 + 归档到独立媒体库
 *
 * 参数（面向 LLM 精简，但覆盖三模态全部能力）：
 * - modality: 'image'|'video'|'audio'（必填）
 * - prompt: 正向提示词（必填）
 * - 图片: negative_prompt / size / aspect_ratio / reference_images / watermark / seed
 * - 视频: duration / resolution / aspect_ratio / reference_images / reference_videos
 *         first_frame / last_frame / reference_audio / generate_audio / watermark / seed
 * - 音频: voice / speed
 * - provider: 供应商（可选，默认该模态的默认供应商）
 */

import type { Tool } from './interface.js';
import { recordMediaFile } from '../media/index.js';

export class GenerateMediaTool implements Tool {
  readonly name = 'generate_media';
  readonly description =
    '多模态生成（图片/视频/音频）。modality 必填（image/video/audio），prompt 必填（正向提示词）。' +
    '图片参数：negative_prompt（负向）、size（2K/3K/4K）、aspect_ratio、reference_images（图生图）、watermark、seed。' +
    '视频参数：duration（秒）、resolution（480p/720p/1080p/4k）、aspect_ratio、reference_images（图生视频首帧）、' +
    'reference_videos（多模态参考）、first_frame/last_frame（首尾帧）、reference_audio、generate_audio（同步音频）、watermark、seed。' +
    '音频参数：voice（音色）、speed（语速）。' +
    'provider 可选（默认取该模态默认供应商）。生成后保存到本地并返回路径。';

  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      modality: {
        type: 'string',
        enum: ['image', 'video', 'audio'],
        description: '生成模态：image（图片）/ video（视频）/ audio（音频）',
      },
      prompt: {
        type: 'string',
        description: '正向提示词，描述要生成的内容',
      },
      // ── 图片参数 ──
      negative_prompt: {
        type: 'string',
        description: '负向提示词，描述不想要的内容（图片专用，如 "模糊，低画质"）',
      },
      size: {
        type: 'string',
        enum: ['2K', '3K', '4K'],
        description: '图片分辨率档位（2K/3K/4K，或像素串如 1024x1024），默认 2K',
      },
      // ── 视频参数 ──
      duration: {
        type: 'number',
        description: '视频时长（秒），Seedance 上限 15 秒',
      },
      resolution: {
        type: 'string',
        enum: ['480p', '720p', '1080p', '4k'],
        description: '视频分辨率档位，默认按模型',
      },
      // ── 通用（图片+视频） ──
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'],
        description: '宽高比（可选，适配器按厂商支持映射）',
      },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图 URL 列表（图生图 / 图生视频首帧用，可选）',
      },
      reference_videos: {
        type: 'array',
        items: { type: 'string' },
        description: '参考视频 URL 列表（多模态参考，仅视频，可选）',
      },
      first_frame: {
        type: 'string',
        description: '首帧图片 URL（图生视频首尾帧，可选）',
      },
      last_frame: {
        type: 'string',
        description: '尾帧图片 URL（图生视频首尾帧，可选）',
      },
      reference_audio: {
        type: 'string',
        description: '参考音频 URL（多模态参考/视频配乐，可选）',
      },
      generate_audio: {
        type: 'boolean',
        description: '是否生成同步音频（视频专用，可选）',
      },
      watermark: {
        type: 'boolean',
        description: '是否添加 AI 水印（可选）',
      },
      seed: {
        type: 'number',
        description: '随机种子（复现用，可选）',
      },
      // ── 音频参数 ──
      voice: {
        type: 'string',
        description: '音色 ID（音频专用，可选）',
      },
      speed: {
        type: 'number',
        description: '语速（音频专用，可选）',
      },
      provider: {
        type: 'string',
        description: '生成供应商名（可选，默认取该模态的默认供应商）',
      },
    },
    required: ['modality', 'prompt'],
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
    const modality = String(args.modality || '').trim();
    if (!['image', 'video', 'audio'].includes(modality)) {
      return `Error: modality must be one of image | video | audio (got "${modality}")`;
    }

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

    // ── 输入 → taskType（按模态 + 参考媒体自动推断）──────────────
    let taskType: 'text_to_image' | 'image_to_image' | 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'audio_tts';
    let refImages: Array<{ type: 'url'; url: string; role: 'reference' | 'first_frame' }> | undefined;
    let refVideos: Array<{ type: 'url'; url: string; role: 'reference_video' }> | undefined;
    let firstFrame: { type: 'url'; url: string } | undefined;
    let lastFrame: { type: 'url'; url: string } | undefined;
    let refAudio: { type: 'url'; url: string } | undefined;

    if (modality === 'image') {
      refImages = Array.isArray(args.reference_images)
        ? (args.reference_images as string[]).map(u => ({ type: 'url' as const, url: String(u), role: 'reference' as const }))
        : undefined;
      taskType = refImages && refImages.length > 0 ? 'image_to_image' : 'text_to_image';
    } else if (modality === 'video') {
      refVideos = Array.isArray(args.reference_videos)
        ? (args.reference_videos as string[]).map(u => ({ type: 'url' as const, url: String(u), role: 'reference_video' as const }))
        : undefined;
      const refImgs = Array.isArray(args.reference_images)
        ? (args.reference_images as string[]).map(u => ({ type: 'url' as const, url: String(u), role: 'first_frame' as const }))
        : undefined;
      if (args.first_frame) firstFrame = { type: 'url', url: String(args.first_frame) };
      if (args.last_frame) lastFrame = { type: 'url', url: String(args.last_frame) };
      if (args.reference_audio) refAudio = { type: 'url', url: String(args.reference_audio) };
      if (refVideos && refVideos.length > 0) {
        taskType = 'reference_to_video';
        refImages = refImgs;
      } else if (refImgs && refImgs.length > 0) {
        taskType = 'image_to_video';
        refImages = refImgs;
      } else if (firstFrame || lastFrame) {
        taskType = 'image_to_video';
      } else {
        taskType = 'text_to_video';
      }
    } else {
      taskType = 'audio_tts';
    }

    // 未指定供应商时，用该任务类型的默认供应商名；都没有则报错并给指引
    const provider = args.provider ? String(args.provider) : undefined;
    let providerName: string | null = provider ?? null;
    if (!providerName) {
      providerName = registry.getDefaultProviderName(taskType);
      if (!providerName) {
        return (
          `Error: no ${modality} generation provider configured.\n` +
          'Set up .agent/generation.json:\n' +
          '{\n' +
          '  "providers": { "minimax": { "type": "minimax", "models": { "' +
          taskType + '": "..." }, "apiKeyEnv": "MINIMAX_API_KEY" } },\n' +
          '  "defaults": { "' + taskType + '": "minimax" }\n' +
          '}\n' +
          'And set the corresponding API key environment variable.'
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
          negativePrompt: args.negative_prompt ? String(args.negative_prompt) : undefined,
          resolution: modality === 'image'
            ? (args.size ? String(args.size) : undefined)
            : (args.resolution ? String(args.resolution) : undefined),
          duration: args.duration !== undefined ? Number(args.duration) : undefined,
          aspectRatio: args.aspect_ratio ? String(args.aspect_ratio) : undefined,
          referenceImages: refImages,
          referenceVideos: refVideos,
          firstFrame,
          lastFrame,
          referenceAudio: refAudio,
          generateAudio: args.generate_audio !== undefined ? Boolean(args.generate_audio) : undefined,
          watermark: args.watermark !== undefined ? Boolean(args.watermark) : undefined,
          seed: args.seed !== undefined ? Number(args.seed) : undefined,
          voice: args.voice ? String(args.voice) : undefined,
          speed: args.speed !== undefined ? Number(args.speed) : undefined,
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
        { type: modality as 'image' | 'video' | 'audio', source: 'generation', taskType, prompt },
        this.mediaDbPath,
      );

      const kind = modality === 'image' ? 'Image' : modality === 'video' ? 'Video' : 'Audio';


      return (
        `${kind} generated and saved to ${artifact.localPath}\n` +
        `Provider: ${artifact.provider} | Size: ${artifact.byteSize} bytes | Media: ${artifact.mediaType}\n` +
        (artifact.width && artifact.height ? `Dimensions: ${artifact.width}x${artifact.height}\n` : '') +
        (artifact.duration ? `Duration: ${artifact.duration}s\n` : '') +
        `Source URL: ${artifact.sourceUrl}` +
        (modality === 'image'
          ? `\n可调用 view_image 传入 ${artifact.localPath} 回看生成结果。`
          : '')
      );
    } catch (err) {
      return `Error generating ${modality}: ${(err as Error).message}`;
    }
  }
}
