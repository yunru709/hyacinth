/**
 * scene_render 窄工具测试 — 陪伴模式场景渲染 + 签名去重
 *
 * 核心验证：
 *   1. 签名去重：相同 scene_desc 第二次调用 → skip（不调生成 API）
 *   2. 场景变化：不同 scene_desc → 重新生成
 *   3. 完整链路：配置好 generation.json + mock fetch → scene.png + scene.json 落盘
 *   4. 未配置供应商 → 返回可操作指引
 *   5. 非法角色名（路径穿越）→ 拒绝
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeSceneRender, SCENE_RENDER_TOOL } from './index.js';
import type { SceneRenderDeps } from './index.js';

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

/** 写入 .agent/generation.json 到 cwd */
function writeGenerationConfig(cwd: string) {
  const agentDir = path.join(cwd, '.agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'generation.json'),
    JSON.stringify({
      providers: {
        volc: {
          type: 'volcengine',
          models: { text_to_image: 'doubao-seedream-5-0-lite-260128' },
          apiKey: 'test-key',
        },
      },
      defaults: { text_to_image: 'volc' },
    }),
  );
}

describe('SCENE_RENDER_TOOL 定义', () => {
  it('工具 schema 固定：只暴露 scene_desc', () => {
    expect(SCENE_RENDER_TOOL.name).toBe('scene_render');
    expect(SCENE_RENDER_TOOL.input_schema).toHaveProperty('properties.scene_desc');
    const props = (SCENE_RENDER_TOOL.input_schema as any).properties;
    expect(Object.keys(props)).toEqual(['scene_desc']); // 窄接口：只有这一个参数
    expect((SCENE_RENDER_TOOL.input_schema as any).required).toContain('scene_desc');
  });
});

describe('executeSceneRender 签名去重', () => {
  let tmpDir: string;
  let deps: SceneRenderDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-render-'));
    writeGenerationConfig(tmpDir);
    deps = {
      characterName: '测试角色',
      cwd: tmpDir,
      outputDir: path.join(tmpDir, 'scene-out'),
      mediaDbPath: path.join(tmpDir, 'media.sqlite'),
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('相同 scene_desc 第二次调用 → skip，不调生成 API', async () => {
    // 第一次：生成 + 下载（2 次 fetch）
    const genFetch = mockFetchOnce({ data: [{ url: 'https://cdn.example.com/scene.png' }] });
    const dlFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('scene-bytes'),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(genFetch)
      .mockImplementationOnce(dlFetch));

    const r1 = await executeSceneRender({ scene_desc: '雨夜的森林木屋，温暖的灯光' }, deps);
    expect(r1).toContain('ok: 场景已渲染');
    expect(fs.existsSync(path.join(deps.outputDir!, 'scene.png'))).toBe(true);
    expect(fs.existsSync(path.join(deps.outputDir!, 'scene.json'))).toBe(true);

    // 清掉 fetch mock，第二次调用若再 fetch 会失败——用 spy 确认没被调用
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r2 = await executeSceneRender({ scene_desc: '雨夜的森林木屋，温暖的灯光' }, deps);
    expect(r2).toContain('skip:');
    expect(fetchSpy).not.toHaveBeenCalled(); // 关键：签名未变，不烧 API
  });

  it('场景变化 → 重新生成并更新 scene.json', async () => {
    const mkFetch = () => {
      const gen = mockFetchOnce({ data: [{ url: 'https://cdn.example.com/s.png' }] });
      const dl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('new-bytes'),
      } as unknown as Response);
      return vi.fn().mockImplementationOnce(gen).mockImplementationOnce(dl);
    };

    vi.stubGlobal('fetch', mkFetch());
    await executeSceneRender({ scene_desc: '晴天的海边' }, deps);
    const meta1 = JSON.parse(fs.readFileSync(path.join(deps.outputDir!, 'scene.json'), 'utf8'));

    vi.stubGlobal('fetch', mkFetch());
    const r2 = await executeSceneRender({ scene_desc: '暴风雪中的雪山小屋' }, deps);
    expect(r2).toContain('ok:');
    const meta2 = JSON.parse(fs.readFileSync(path.join(deps.outputDir!, 'scene.json'), 'utf8'));
    expect(meta2.signature).not.toBe(meta1.signature); // 签名更新
    expect(meta2.prompt).toBe('暴风雪中的雪山小屋');
  });
});

describe('executeSceneRender 边界', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-render-'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scene_desc 缺失 → 报错', async () => {
    const r = await executeSceneRender({}, { characterName: '测试', cwd: tmpDir });
    expect(r).toContain('scene_desc 缺失');
  });

  it('未配置供应商 → 返回配置指引', async () => {
    const r = await executeSceneRender(
      { scene_desc: 'test' },
      { characterName: '测试', cwd: tmpDir }, // 无 generation.json
    );
    expect(r).toContain('未配置图片生成供应商');
    expect(r).toContain('generation.json');
  });

  it('非法角色名（路径穿越）→ 拒绝', async () => {
    const r = await executeSceneRender(
      { scene_desc: 'test' },
      { characterName: '../../evil', cwd: tmpDir },
    );
    expect(r).toContain('error');
    expect(r).toContain('非法路径字符');
  });

  it('空角色名 → 拒绝', async () => {
    const r = await executeSceneRender(
      { scene_desc: 'test' },
      { characterName: '', cwd: tmpDir },
    );
    expect(r).toContain('error');
    expect(r).toContain('不能为空');
  });
});
