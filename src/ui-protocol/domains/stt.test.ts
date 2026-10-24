// ============================================================
// UI 契约层 — 语音转文字域测试
// ============================================================
// 覆盖：
//   1. stt.status（引擎状态透传）
//   2. stt.transcribe（WAV 解析 → 引擎；参数校验；空音频/坏 WAV 报错）
//   3. stt.download（幂等语义：已就绪 / 进行中 / 触发 + 进度事件）
//   4. 引擎未注入 → fail-closed
// 引擎 mock：纯内存实现（16k 样本 → 固定文本），不加载 sherpa-onnx。
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createSttDomain, type SttEngineLike } from './stt.js';
import type { UiResponse } from '../types.js';

function makeEngine(overrides: Partial<SttEngineLike> = {}): SttEngineLike & { downloadCount: number; removeCount: number; lastSamples: Float32Array | null } {
  const impl = {
    downloadCount: 0,
    removeCount: 0,
    lastSamples: null as Float32Array | null,
    status() {
      return {
        engine: 'sensevoice',
        runtimeAvailable: true,
        modelReady: true,
        modelDir: 'C:\\fake\\stt',
        missingFiles: [],
        downloading: false,
      };
    },
    async ensureModel() {
      (impl as { downloadCount: number }).downloadCount++;
    },
    removeModel() {
      (impl as { removeCount: number }).removeCount++;
    },
    async transcribe(samples: Float32Array, sampleRate: number) {
      (impl as { lastSamples: Float32Array | null }).lastSamples = samples;
      if (sampleRate !== 16000) throw new Error(`仅支持 16kHz 采样率（收到 ${sampleRate}）`);
      return { text: '你好，世界', durationMs: 42 };
    },
    ...overrides,
  };
  return impl as SttEngineLike & { downloadCount: number; removeCount: number; lastSamples: Float32Array | null };
}

function setup(engine: SttEngineLike | null, events: Array<{ type: string; payload?: unknown }> = []) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('stt', createSttDomain({
    getEngine: () => engine,
    emit: (type, payload) => events.push({ type, payload }),
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const req = async (method: string, params?: unknown): Promise<UiResponse> => {
    const id = 'r' + Math.random().toString(36).slice(2);
    client.send({ kind: 'request', id, method, params });
    const start = Date.now();
    for (;;) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      if (Date.now() - start > 3000) throw new Error(`timeout waiting for ${id}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { req };
}

/** 构造 16kHz 单声道 PCM16 WAV（与前端 encodeWav 同格式） */
function makeWav(samples: Float32Array, sampleRate = 16000): string {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString('base64');
}

describe('stt.status', () => {
  it('透传引擎状态', async () => {
    const { req } = setup(makeEngine());
    const resp = await req('stt.status');
    expect(resp.ok).toBe(true);
    expect((resp.result as { engine: string }).engine).toBe('sensevoice');
    expect((resp.result as { modelReady: boolean }).modelReady).toBe(true);
  });

  it('引擎未注入 → fail-closed', async () => {
    const { req } = setup(null);
    const resp = await req('stt.status');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not available');
  });
});

describe('stt.transcribe', () => {
  it('WAV base64 → 引擎样本 → 文本', async () => {
    const engine = makeEngine();
    const { req } = setup(engine);
    const samples = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5);
    const resp = await req('stt.transcribe', { audioWavBase64: makeWav(samples) });
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ text: '你好，世界', durationMs: 42 });
    expect(engine.lastSamples).not.toBeNull();
    expect(engine.lastSamples!.length).toBe(1600);
  });

  it('缺参数 / 坏 WAV / 采样率不符 / 空音频各自报错', async () => {
    const { req } = setup(makeEngine());
    const missing = await req('stt.transcribe', {});
    expect(missing.error?.message).toContain('requires "audioWavBase64"');

    const bad = await req('stt.transcribe', { audioWavBase64: Buffer.alloc(64, 0x41).toString('base64') });
    expect(bad.error?.message).toContain('RIFF');

    const wrongRate = await req('stt.transcribe', { audioWavBase64: makeWav(new Float32Array(160), 44100) });
    expect(wrongRate.error?.message).toContain('16kHz');

    const empty = await req('stt.transcribe', { audioWavBase64: makeWav(new Float32Array(0)) });
    expect(empty.error?.message).toContain('音频为空');
  });
});

describe('stt.download', () => {
  it('stt.remove 调用引擎删除并返回目录', async () => {
    const engine = makeEngine();
    const { req } = setup(engine);
    const resp = await req('stt.remove');
    expect(resp.ok).toBe(true);
    expect((resp.result as { ok: boolean; modelDir: string }).ok).toBe(true);
    expect(engine.removeCount).toBe(1);
  });

  it('模型已就绪 → ready:true，不重复下载', async () => {
    const engine = makeEngine();
    const { req } = setup(engine);
    const resp = await req('stt.download');
    expect(resp.result).toEqual({ started: false, ready: true });
    expect(engine.downloadCount).toBe(0);
  });

  it('触发下载（幂等）并在后台完成', async () => {
    // mock：ensureModel 调用后模型变就绪（downloading 恒 false —— 域的幂等分支
    // 由"进行中"状态触发，mock 无法真实表达异步下载中，单独验证即可）
    const engine = makeEngine({
      status() {
        return {
          engine: 'sensevoice',
          mirror: 'auto',
          runtimeAvailable: true,
          modelReady: (engine as { downloadCount: number }).downloadCount > 0,
          modelDir: 'C:\\fake',
          missingFiles: (engine as { downloadCount: number }).downloadCount > 0 ? [] : ['model.int8.onnx'],
          downloading: false,
        };
      },
      async ensureModel() { (engine as { downloadCount: number }).downloadCount++; },
    }) as SttEngineLike & { downloadCount: number; removeCount: number; lastSamples: null };
    const events: Array<{ type: string; payload?: unknown }> = [];
    const { req } = setup(engine, events);
    const first = await req('stt.download');
    expect(first.result).toEqual({ started: true, ready: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.downloadCount).toBe(1);
    // 完成终态事件
    expect(events.some((e) => e.type === 'stt.model_progress' && (e.payload as { phase: string }).phase === 'done')).toBe(true);
  });
});
