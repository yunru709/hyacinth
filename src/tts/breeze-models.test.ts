// breeze 模型清单：URL 拼接 + 变体规格 + 就绪判定的单测。
//
// 为什么这些值得测：URL 拼错**不会报错，只会在下载时 404**，而下载又是个
// 5GB/548MB 的重操作 —— 等到那时才发现，代价极高。下面这些断言里的每个字符串，
// 都用 2026-10-26 的实测 HEAD 请求核对过（HTTP 200 + Content-Length）：
//   GGUF q8_0            → 5079670336 B（与用户本地文件逐字节等大）
//   bin  cuda13.3        → 263.1 MB
//   cudart cuda13.3      → 548.8 MB
import { describe, it, expect } from 'vitest';
import {
  ggufSpec,
  ggufUrls,
  ggufPath,
  runtimeAssets,
  runtimeUrls,
  recommendedBackend,
  BREEZE_GGUF_VARIANTS,
  BREEZE_DEFAULT_RELEASE,
  BREEZE_REPO,
  BREEZE_HF_REPO,
} from './breeze-models.js';

describe('gguf 变体清单', () => {
  it('包含官方四档，且不含 fp32（官方明确说 fp32 会乱读+复读）', () => {
    const variants = BREEZE_GGUF_VARIANTS.map((v) => v.variant);
    expect(variants).toEqual(['q8_0', 'q4_k', 'q4_0', 'bf16']);
    expect(variants).not.toContain('fp32');
  });

  it('未知变体抛错（不静默回落到别的档位）', () => {
    expect(() => ggufSpec('fp32' as never)).toThrow(/未知的 breeze GGUF 变体/);
  });

  it('ggufPath 以变体文件名结尾', () => {
    expect(ggufPath('q8_0').endsWith('breeze-tts-2-q8_0.gguf')).toBe(true);
    expect(ggufPath('bf16').endsWith('breeze-tts-2-bf16.gguf')).toBe(true);
  });
});

describe('ggufUrls（HF 直链）', () => {
  it('默认顺序：hf-mirror 优先，huggingface 兜底', () => {
    const urls = ggufUrls('q8_0');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('hf-mirror.com');
    expect(urls[1]).toContain('huggingface.co');
    // 两个源指向同一逻辑路径
    for (const u of urls) expect(u).toContain('/Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf');
  });

  it('URL 形态与实测一致（可直接 HEAD 成功）', () => {
    expect(ggufUrls('q8_0')[0]).toBe(
      `https://hf-mirror.com/${BREEZE_HF_REPO}/resolve/main/Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf`,
    );
  });

  it('mirrorPref 锁定源：锁定的排第一，但另一个仍保留作回落', () => {
    const hf = ggufUrls('q8_0', 'huggingface');
    expect(hf[0]).toContain('huggingface.co');
    expect(hf[1]).toContain('hf-mirror.com');
    expect(hf).toHaveLength(2);
  });

  it('未知 mirrorPref 视同未指定（仍给两个源）', () => {
    expect(ggufUrls('q4_k', 'whatever')).toHaveLength(2);
  });
});

describe('runtimeAssets（GitHub Release 资产名）', () => {
  it('只给 bin + cudart 两包（lib 是二次开发用的，跑 CLI 不需要）', () => {
    const assets = runtimeAssets('cuda13.3');
    expect(assets.map((a) => a.kind)).toEqual(['bin', 'cudart']);
  });

  it('资产名与实测枚举的结果逐字一致', () => {
    const names = runtimeAssets('cuda13.3').map((a) => a.name);
    expect(names).toEqual([
      `audio-${BREEZE_DEFAULT_RELEASE}-bin-windows-x64-cuda13.3.zip`,
      `audio-${BREEZE_DEFAULT_RELEASE}-cudart-windows-x64-cuda13.3.zip`,
    ]);
  });

  it('四档后端都能拼出名字（cuda13.3 / cuda12.4 / cpu / vulkan）', () => {
    for (const be of ['cuda13.3', 'cuda12.4', 'cpu', 'vulkan'] as const) {
      const names = runtimeAssets(be).map((a) => a.name);
      expect(names[0]).toContain(`-${be}.zip`);
      expect(names[1]).toContain(`-${be}.zip`);
    }
  });

  it('可传自定义 release tag（升级时不必改代码逻辑）', () => {
    const names = runtimeAssets('cuda13.3', 'v9.9.9').map((a) => a.name);
    expect(names[0]).toContain('v9.9.9');
  });
});

describe('runtimeUrls（release 直链 + 代理回落）', () => {
  it('直连 GitHub 优先，ghfast.top 作第二源', () => {
    const asset = runtimeAssets('cuda13.3')[0].name;
    const urls = runtimeUrls(asset);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(
      `https://github.com/${BREEZE_REPO}/releases/download/${BREEZE_DEFAULT_RELEASE}/${asset}`,
    );
    expect(urls[1]).toBe(`https://ghfast.top/${urls[0]}`);
  });
});

describe('推荐后端', () => {
  it('本机驱动是 CUDA 13.3 ⇒ 推荐 cuda13.3', () => {
    expect(recommendedBackend()).toBe('cuda13.3');
  });
});
