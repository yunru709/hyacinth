/**
 * 端到端集成测试 — 真实 HTTP server 模拟火山 API，验证完整生成链路
 *
 * 与 volcengine.test.ts（mock fetch）的区别：
 * - 这里用 node:http 起真实本地 server，走真实 HTTP 协议栈
 * - server 返回真实 PNG 字节（1x1 透明像素），验证下载落盘后文件有效
 *
 * 验证链路：
 *   GenerationService.generate()
 *     → submitTask（POST /images/generations，真实 HTTP）
 *     → 响应解析（task 状态）
 *     → 下载转存（真实 HTTP GET 图片）
 *     → 落盘 outputs/generation/xxx.png
 *     → 文件 magic bytes 校验（确为 PNG）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerationRegistry, GenerationService } from './index.js';
import { GenerateMediaTool } from '../tools/generate-media.js';

/** 1x1 透明 PNG */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server: http.Server;
let baseUrl: string;
/** server 收到的最后一次生成请求体 */
let lastGenBody: any = null;

/** 模拟火山 API 的 server */
async function startMockServer(): Promise<{ baseUrl: string }> {
  const srv = http.createServer((req, res) => {
    // 图片生成端点
    if (req.method === 'POST' && req.url === '/images/generations') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        lastGenBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          created: 1750000000,
          model: 'test-model',
          data: [{ url: `${baseUrl}/download/img.png`, size: '1024x1024' }],
          usage: { output_tokens: 100, total_tokens: 120 },
        }));
      });
      return;
    }
    // 图片下载端点
    if (req.method === 'GET' && req.url === '/download/img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_BYTES);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NotFound', message: 'no route' } }));
  });

  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  server = srv; // 赋值给全局，供 afterAll close
  return { baseUrl: `http://127.0.0.1:${port}` };
}

describe('generation end-to-end (real HTTP)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    ({ baseUrl } = await startMockServer());
  });
  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-e2e-'));
    lastGenBody = null;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GenerationService 全链路：真实 HTTP 提交 + 下载 + 落盘有效 PNG', async () => {
    // 配置指向本地模拟 server
    const registry = new GenerationRegistry({
      providers: {
        volc: {
          type: 'volcengine',
          baseUrl,
          models: { text_to_image: 'doubao-seedream-5-0-lite-260128' },
          apiKey: 'test-key',
        },
      },
      defaults: { text_to_image: 'volc' },
    });

    const svc = new GenerationService(registry, tmpDir);
    const artifact = await svc.generate(
      {
        provider: 'volc',
        taskType: 'text_to_image',
        prompt: '一只在雨中的赛博朋克小猫',
        negativePrompt: '模糊，低画质',
      },
      { outputDir: path.join(tmpDir, 'outputs', 'generation') },
    );

    // 1. server 收到了正确的请求体
    expect(lastGenBody).not.toBeNull();
    expect(lastGenBody.model).toBe('doubao-seedream-5-0-lite-260128');
    expect(lastGenBody.prompt).toContain('--neg: 模糊，低画质');
    expect(lastGenBody.response_format).toBe('url');

    // 2. 落盘文件存在
    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.localPath).toContain('outputs');

    // 3. 文件是有效 PNG（magic bytes）
    const buf = fs.readFileSync(artifact.localPath);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x89);
    expect(buf.toString('hex', 0, 8)).toBe('89504e470d0a1a0a'); // PNG signature

    // 4. 元数据正确
    expect(artifact.mediaType).toBe('image/png');
    expect(artifact.provider).toBe('volcengine');
    expect(artifact.width).toBe(1024);
    expect(artifact.height).toBe(1024);
  });

  it('GenerateMediaTool 工具入口：LLM 调用路径也能走通', async () => {
    // 写入工具会读取的 .agent/generation.json
    const agentDir = path.join(tmpDir, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'generation.json'),
      JSON.stringify({
        providers: {
          volc: {
            type: 'volcengine',
            baseUrl,
            models: { text_to_image: 'doubao-seedream-5-0-lite-260128' },
            apiKey: 'test-key',
          },
        },
        defaults: { text_to_image: 'volc' },
      }),
    );

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'));
    const result = await tool.execute({
      modality: 'image',
      prompt: '赛博朋克小猫',
      negative_prompt: '模糊',
      size: '2K',
    });

    // 工具返回本地路径
    expect(result).toContain('Image generated and saved to');
    expect(result).toContain('outputs');
    expect(result).toContain('image/png');
    expect(result).toContain('1024x1024');

    // 提取路径并校验是有效 PNG
    const m = result.match(/saved to (.+?)(?:\n|$)/);
    expect(m).not.toBeNull();
    const savedPath = m![1];
    const buf = fs.readFileSync(savedPath);
    expect(buf.toString('hex', 0, 8)).toBe('89504e470d0a1a0a'); // PNG signature
  });
});

