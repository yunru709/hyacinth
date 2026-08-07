/**
 * runGenerationWizard 集成测试 — 完整链路验证
 *
 * mock @clack/prompts 模拟交互（选厂商 / 输 API key / 多选模态 / 输模型名），
 * mock os.homedir 隔离目录，验证：
 *   - API key 正确写入 ~/.agent/.env
 *   - generation.json 结构正确（providers + defaults）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 隔离 homedir（ConfigManager configDir / generation.json 都用 ~/.agent）──
const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: vi.fn(() => os.tmpdir()) }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});

// ── mock @clack/prompts（模拟交互返回值）─────────────────────────────
const { mockSelect, mockMultiselect, mockText, mockIsCancel } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockMultiselect: vi.fn(),
  mockText: vi.fn(),
  mockIsCancel: vi.fn(() => false),
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: mockIsCancel,
  select: mockSelect,
  multiselect: mockMultiselect,
  text: mockText,
}));

import { runGenerationWizard } from './generation-wizard.js';
import { ConfigManager } from './config.js';

describe('runGenerationWizard 集成', () => {
  let tempDir: string;
  let manager: ConfigManager;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `agent-genwiz-${crypto.randomUUID()}`);
    mockHomedir.mockReturnValue(tempDir);
    manager = new ConfigManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('完整链路：选 volcengine → 写 ARK_API_KEY → 写 generation.json（图片+视频）', async () => {
    // 交互序列：
    //   select: 厂商 → volcengine
    //   text:   API key → test-key
    //   multiselect: 模态 → [image, video]
    //   text × 5: 每个 taskType 模型名
    mockSelect.mockResolvedValue('volcengine');
    mockText
      .mockResolvedValueOnce('test-key')                                  // API key
      .mockResolvedValueOnce('seedream-5')                                // text_to_image
      .mockResolvedValueOnce('seedream-5')                                // image_to_image
      .mockResolvedValueOnce('seedance-2')                                // text_to_video
      .mockResolvedValueOnce('seedance-2')                                // image_to_video
      .mockResolvedValueOnce('seedance-2');                               // reference_to_video
    mockMultiselect.mockResolvedValue(['image', 'video']);

    const result = await runGenerationWizard(manager);

    expect(result.skipped).toBe(false);
    expect(result.envKey).toBe('ARK_API_KEY');

    // 1) API key 写入 .env
    const envPath = path.join(tempDir, '.agent', '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const envContent = fs.readFileSync(envPath, 'utf8');
    expect(envContent).toContain('ARK_API_KEY=test-key');

    // 2) generation.json 结构正确
    const configPath = path.join(tempDir, '.agent', 'generation.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const gen = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(gen.providers.volcengine).toBeDefined();
    expect(gen.providers.volcengine.type).toBe('volcengine');
    expect(gen.providers.volcengine.apiKeyEnv).toBe('ARK_API_KEY');
    expect(gen.providers.volcengine.models).toEqual({
      text_to_image: 'seedream-5',
      image_to_image: 'seedream-5',
      text_to_video: 'seedance-2',
      image_to_video: 'seedance-2',
      reference_to_video: 'seedance-2',
    });
    // defaults：每个启用的 taskType 路由到该厂商
    expect(gen.defaults.text_to_image).toBe('volcengine');
    expect(gen.defaults.text_to_video).toBe('volcengine');
  });

  it('模态多选只选图片 → 仅图片 taskType 入配置', async () => {
    mockSelect.mockResolvedValue('volcengine');
    mockText
      .mockResolvedValueOnce('key-1')
      .mockResolvedValueOnce('seedream-5')
      .mockResolvedValueOnce('seedream-5');
    mockMultiselect.mockResolvedValue(['image']);

    const result = await runGenerationWizard(manager);

    const gen = JSON.parse(fs.readFileSync(path.join(tempDir, '.agent', 'generation.json'), 'utf8'));
    expect(gen.providers.volcengine.models).toEqual({
      text_to_image: 'seedream-5',
      image_to_image: 'seedream-5',
    });
    expect(gen.defaults.text_to_video).toBeUndefined();
    expect(result.skipped).toBe(false);
  });

  it('取消选择厂商 → skipped', async () => {
    // isCancel mock 恒 false，这里模拟 select 返回 symbol（取消信号）需让 isCancel 返回 true
    const { isCancel } = await import('@clack/prompts');
    (isCancel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockSelect.mockResolvedValue(Symbol('cancel'));

    const result = await runGenerationWizard(manager);
    expect(result.skipped).toBe(true);
    expect(result.config).toBeNull();
  });
});
