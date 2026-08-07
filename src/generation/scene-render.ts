/**
 * scene_render — 陪伴模式场景渲染窄工具（旁路 agent 专用）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️  bypass 安全红线 · 本工具挂在旁路陪伴 agent（元认知层）上
 * ══════════════════════════════════════════════════════════════════
 * 通过安全三问（见 src/bypass/base.ts 头部）：
 *   1. 只做一件事？—— 是：把场景画面描述渲染成固定路径的背景图
 *   2. 只读写固定路径？—— 是：只写 ~/.agent/companion/<角色>/scene.png + scene.json
 *   3. 非通用？—— 是：LLM 只能传 scene_desc（画面描述），HTTP/生成调用
 *      封装在工具内部，旁路 agent 永远不接触通用能力。
 *
 * 【签名去重 —— 防每轮烧 API + 画面闪动】
 *   scene.json 记录上次渲染的画面签名（scene_desc 规范化 hash）。
 *   LLM 每轮 observe 都可能调用本工具，但若 scene_desc 未变 → 直接跳过，
 *   不调生成 API。这是框架层硬保护；提示词层另有"场景显著变化才调"软引导。
 *
 * 【输出协议】
 *   scene.png    ← 生成图片（固定文件名，供 WebUI 背景播放器消费）
 *   scene.json   ← 元数据：{ signature, prompt, provider, createdAt }
 *   前端复用 hyacinth serve 读这两个文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../types.js';
import { recordMediaFile } from '../media/index.js';

// ── 工具定义（LLM 可见面）────────────────────────────────────────

export const SCENE_RENDER_TOOL: ToolDefinition = {
  name: 'scene_render',
  description:
    '把当前场景画面渲染成背景图（陪伴模式的视觉背景）。' +
    'scene_desc=一句话画面描述（中文，描述当前环境/天气/氛围/在场角色与动作，供绘画模型使用）。' +
    '仅在【场景显著变化】时调用（地点换了/天气突变/重要事件/新角色出现）；' +
    '场景没变就不要调——重复调用会被自动跳过，不产生新图。',
  input_schema: {
    type: 'object',
    properties: {
      scene_desc: {
        type: 'string',
        description: '画面描述（中文一句话，描述环境/天气/氛围/人物，供绘画模型）',
      },
    },
    required: ['scene_desc'],
  },
};

// ── 类型 ─────────────────────────────────────────────────────────

export interface SceneRenderDeps {
  /** 陪伴角色名（决定输出目录 ~/.agent/companion/<角色>/） */
  characterName: string;
  /** 工作目录（加载 generation 配置用），默认 process.cwd() */
  cwd?: string;
  /** 覆盖输出目录（默认 ~/.agent/companion/<角色>/，测试隔离用） */
  outputDir?: string;
  /** 覆盖媒体库路径（默认 ~/.agent/media/media.sqlite，测试隔离用） */
  mediaDbPath?: string;
}

interface SceneMeta {
  signature: string;
  prompt: string;
  provider: string;
  createdAt: string;
}

// ── 内部：路径 / 签名 ─────────────────────────────────────────────

/** scene 输出目录：~/.agent/companion/<角色>/ */
export function getSceneDir(characterName: string): string {
  return path.join(os.homedir(), '.agent', 'companion', characterName);
}

/** 规范化签名：去空白 + 折叠重复空格 + 取前 500 字 → sha256 前 16 */
function makeSignature(sceneDesc: string): string {
  const normalized = sceneDesc.replace(/\s+/g, ' ').trim().slice(0, 500);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** 读取上次渲染元数据（无则返回 null） */
function readSceneMetaFromDir(sceneDir: string): SceneMeta | null {
  try {
    const p = path.join(sceneDir, 'scene.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as SceneMeta;
    if (raw && typeof raw.signature === 'string') return raw;
    return null;
  } catch {
    return null;
  }
}

/** 校验角色名安全（防路径穿越） */
function assertSafeCharacter(name: string): void {
  if (!name || !name.trim()) throw new Error('[scene_render] characterName 不能为空');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('[scene_render] characterName 含非法路径字符');
  }
  if (name === 'default') throw new Error('[scene_render] characterName 不能为保留名 default');
}

// ── 执行入口 ──────────────────────────────────────────────────────

/**
 * 执行 scene_render。返回给 LLM 的结果文本。
 * - 签名未变 → 跳过（不烧 API）
 * - 签名变化 → 调 GenerationService 生成 → 写 scene.png + scene.json
 */
export async function executeSceneRender(
  input: Record<string, unknown>,
  deps: SceneRenderDeps,
): Promise<string> {
  const sceneDesc = String(input.scene_desc ?? '').trim();
  if (!sceneDesc) return 'error: scene_desc 缺失';

  try {
    assertSafeCharacter(deps.characterName);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }

  const signature = makeSignature(sceneDesc);
  // 输出目录：默认 ~/.agent/companion/<角色>/，测试可覆盖
  const sceneDir = deps.outputDir ?? getSceneDir(deps.characterName);
  const prev = readSceneMetaFromDir(sceneDir);
  if (prev && prev.signature === signature) {
    // 签名未变 → 跳过，防每轮烧 API
    return `skip: 场景未变化（${prev.createdAt} 已渲染过），未生成新图。只在场景显著变化时才需要重新渲染。`;
  }

  // 懒加载 generation 模块（避免 tools ↔ generation 循环依赖）
  let GenerationRegistry: typeof import('./index.js').GenerationRegistry;
  let GenerationService: typeof import('./index.js').GenerationService;
  try {
    const mod = await import('./index.js');
    GenerationRegistry = mod.GenerationRegistry;
    GenerationService = mod.GenerationService;
  } catch (err) {
    return `error: generation module unavailable: ${(err as Error).message}`;
  }

  let registry: InstanceType<typeof GenerationRegistry>;
  try {
    registry = GenerationRegistry.load(deps.cwd ?? process.cwd());
  } catch (err) {
    return `error: 生成配置不可用（${(err as Error).message}）。需要 .agent/generation.json + ARK_API_KEY。`;
  }

  const providerName = registry.getDefaultProviderName('text_to_image');
  if (!providerName) {
    return (
      'error: 未配置图片生成供应商。需要 .agent/generation.json：' +
      '{ "providers": { "volc": { "type": "volcengine", "models": { "text_to_image": "..." }, "apiKeyEnv": "ARK_API_KEY" } }, "defaults": { "text_to_image": "volc" } }'
    );
  }

  const service = new GenerationService(registry, deps.cwd ?? process.cwd());
  let artifact;
  try {
    artifact = await service.generate(
      { provider: providerName, taskType: 'text_to_image', prompt: sceneDesc },
      { outputDir: sceneDir },
    );
  } catch (err) {
    return `error: 场景生成失败：${(err as Error).message}`;
  }

  // 转存到固定文件名 scene.png（service 默认文件名带 taskId 时间戳）
  fs.mkdirSync(sceneDir, { recursive: true });

  const ext = path.extname(artifact.localPath) || '.png';
  const scenePath = path.join(sceneDir, `scene${ext}`);
  fs.copyFileSync(artifact.localPath, scenePath);

  // 写 scene.json 元数据（含签名，供下次去重）
  const meta: SceneMeta = {
    signature,
    prompt: sceneDesc,
    provider: artifact.provider,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify(meta, null, 2), 'utf8');

  // 归档到媒体库（独立 media.sqlite；失败不阻断主流程）
  recordMediaFile(
    scenePath,
    { type: 'image', source: 'scene', character: deps.characterName, signature, prompt: sceneDesc },
    deps.mediaDbPath,
  );

  return (
    `ok: 场景已渲染到 ${scenePath}\n` +
    `Provider: ${artifact.provider} | Media: ${artifact.mediaType}\n` +
    (artifact.width && artifact.height ? `Dimensions: ${artifact.width}x${artifact.height}\n` : '') +
    '（WebUI 背景将自动更新为这张图）'
  );
}
