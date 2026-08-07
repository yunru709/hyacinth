/**
 * GenerateImageTool — 主 agent 通用图像生成工具。
 *
 * 链路：LLM 调用 → 本工具 → GenerationService.generate() → 适配器 → 落盘 outputs/generation/
 *
 * 设计要点：
 * - 懒加载 generation 模块（避免 tools → generation 循环依赖）
 * - 供应商未配置时给出明确指引（需要 .agent/generation.json + API key）
 * - 生成结果返回本地落盘路径，供后续 view_image / 渠道直发使用
 *
 * 参数（面向 LLM 精简）：
 * - prompt: 正向提示词（必填）
 * - negative_prompt: 负向提示词（可选，Seedream 拼接 --neg:）
 * - size: '1K'|'2K'|'3K'|'4K'（默认 2K）
 * - aspect_ratio: 宽高比（可选，默认按模型）
 * - reference_images: 参考图 URL 数组（图生图，可选）
 * - provider: 供应商（可选，默认 image 模态）
 * - watermark: 是否加水印（可选）
 */

import type { Tool } from './interface.js';
import { recordMediaFile } from '../media/index.js';

export class GenerateImageTool implements Tool {
  readonly name = 'generate_image';
  readonly description =
    '生成图片。prompt 必填（正向提示词），可选 negative_prompt（负向提示词）、size（1K/2K/3K/4K）、reference_images（参考图 URL 数组，用于图生图）、watermark。结果保存到本地 outputs/generation/ 并返回路径。';

  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '正向提示词（中文 ≤300 字 / 英文 ≤600 词）',
      },
      negative_prompt: {
        type: 'string',
        description: '负向提示词，描述不想要的内容（如 "模糊，低画质"）',
      },
      size: {
        type: 'string',
        enum: ['2K', '3K', '4K'],
        description: '分辨率档位（2K/3K/4K，或像素串如 1024x1024），默认 2K',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'],
        description: '宽高比（可选，适配器按厂商支持映射）',
      },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图 URL 列表（图生图/多图融合用，可选）',
      },
      provider: {
        type: 'string',
        description: '生成供应商名（可选，默认取配置中 image 模态的默认供应商）',
      },
      watermark: {
        type: 'boolean',
        description: '是否添加 AI 水印（可选）',
      },
    },
    required: ['prompt'],
  };

  private cwd: string;
  private outputDir?: string;
  private mediaDbPath?: string;

  constructor(cwd?: string, outputDir?: string, mediaDbPath?: string) {
    this.cwd = cwd ?? process.cwd();
    this.outputDir = outputDir;
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

    const provider = args.provider ? String(args.provider) : undefined;
    // 参考图 → image_to_image，否则 text_to_image
    const refs = Array.isArray(args.reference_images)
      ? (args.reference_images as string[]).map(u => ({ type: 'url' as const, url: String(u), role: 'reference' as const }))
      : undefined;
    const taskType = refs && refs.length > 0 ? 'image_to_image' : 'text_to_image';

    // 未指定供应商时，用该任务类型的默认供应商名；都没有则报错并给指引
    let providerName: string | null = provider ?? null;
    if (!providerName) {
      providerName = registry.getDefaultProviderName(taskType);
      if (!providerName) {
        return (
          'Error: no image generation provider configured.\n' +
          'Set up .agent/generation.json:\n' +
          '{\n' +
          '  "providers": { "volc": { "type": "volcengine", "models": { "text_to_image": "doubao-seedream-5-0-lite-260128" }, "apiKeyEnv": "ARK_API_KEY" } },\n' +
          '  "defaults": { "text_to_image": "volc" }\n' +
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
          negativePrompt: args.negative_prompt ? String(args.negative_prompt) : undefined,
          resolution: args.size ? String(args.size) : undefined,
          aspectRatio: args.aspect_ratio ? String(args.aspect_ratio) : undefined,
          referenceImages: refs,
          watermark: args.watermark !== undefined ? Boolean(args.watermark) : undefined,
        },
        // 未显式指定 outputDir 时，service 默认落 ~/.agent/generation（用户运行环境）
        this.outputDir ? { outputDir: this.outputDir } : {},
      );

      if (!artifact.localPath) {
        return `Generated (remote only): ${artifact.sourceUrl}`;
      }

      // 归档到媒体库（独立 media.sqlite；失败不阻断主流程）
      recordMediaFile(
        artifact.localPath,
        { type: 'image', source: 'generation', taskType, prompt },
        this.mediaDbPath,
      );

      return (
        `Image generated and saved to ${artifact.localPath}\n` +
        `Provider: ${artifact.provider} | Size: ${artifact.byteSize} bytes | Media: ${artifact.mediaType}\n` +
        (artifact.width && artifact.height ? `Dimensions: ${artifact.width}x${artifact.height}\n` : '') +
        `Source URL: ${artifact.sourceUrl}`
      );
    } catch (err) {
      return `Error generating image: ${(err as Error).message}`;
    }
  }
}
