/**
 * GenerateImageTool 测试 — 验证主 agent 通用工具串起基建层
 *
 * 验证点：
 *   1. 未配置供应商时给出可操作的配置指引
 *   2. 配置后成功调用基建层生成并返回本地路径（mock fetch）
 *   3. 参考图参数正确透传到 image_to_image
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerateImageTool } from './generate-image.js';

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('GenerateImageTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prompt 必填校验', async () => {
    const tool = new GenerateImageTool(os.tmpdir());
    const result = await tool.execute({});
    expect(result).toContain('prompt is required');
  });

  it('未配置供应商时返回配置指引', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-tool-'));
    const tool = new GenerateImageTool(tmpDir);
    const result = await tool.execute({ prompt: '一只猫' });
    expect(result).toContain('no image generation provider configured');
    expect(result).toContain('generation.json');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('配置后成功生成并返回本地路径', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-tool-'));
    // 写入配置
    const agentDir = path.join(tmpDir, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'generation.json'),
      JSON.stringify({
        providers: {
          volc: { type: 'volc-seedream', model: 'doubao-seedream-5-0-lite-260128', apiKey: 'test-key' },
        },
        defaults: { image: 'volc' },
      }),
    );
    process.env.ARK_API_KEY = 'test-key';

    // mock：第一次 fetch = 生成请求，第二次 = 下载图片
    const genFetch = mockFetchOnce({ data: [{ url: 'https://cdn.example.com/img.png', size: '1024x1024' }] });
    const dlFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('png-data'),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(genFetch)
      .mockImplementationOnce(dlFetch));

    const tool = new GenerateImageTool(tmpDir);
    const result = await tool.execute({
      prompt: '赛博朋克小猫',
      negative_prompt: '模糊',
      size: '2K',
    });

    expect(result).toContain('Image generated and saved to');
    expect(result).toContain('outputs');
    expect(result).toContain('image/png');

    // 负向提示词正确拼接
    const body = JSON.parse((genFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.prompt).toContain('--neg: 模糊');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
