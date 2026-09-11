import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBridge } from './model-bridge.js';

/** 假下载器：可在临时目录创建 llama-server.exe，或模拟失败 */
function makeFakeDownloader(opts: { fail?: boolean; createFile?: boolean } = {}) {
  const calls: Array<{ projectRoot: string; onProgress?: (p: number, s: string) => void }> = [];
  const download = vi.fn(async (projectRoot: string, onProgress?: (p: number, s: string) => void) => {
    calls.push({ projectRoot, onProgress });
    onProgress?.(50, '10.0 MB/s');
    if (opts.fail) {
      throw new Error('GitHub API 访问受限（模拟失败）');
    }
    if (opts.createFile) {
      const dir = join(projectRoot, 'libs', 'llama.cpp');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'llama-server.exe'), 'fake-binary');
    }
    return 'b1234';
  });
  return { download, calls };
}

describe('ModelBridge.ensureBinary — llama.cpp 二进制自愈', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('二进制已存在时直接返回路径，不触发下载', async () => {
    const dir = join(root, 'libs', 'llama.cpp');
    mkdirSync(dir, { recursive: true });
    const serverPath = join(dir, 'llama-server.exe');
    writeFileSync(serverPath, 'x');

    const fake = makeFakeDownloader({ createFile: false });
    const bridge = new ModelBridge(root, serverPath, fake as never);

    const result = await bridge.ensureBinary();
    expect(result).toBe(serverPath);
    expect(fake.download).not.toHaveBeenCalled();
  });

  it('缺失时自动下载并在完成后解析出路径', async () => {
    const fake = makeFakeDownloader({ createFile: true });
    const bridge = new ModelBridge(root, null, fake as never);

    const result = await bridge.ensureBinary();
    expect(result).toBe(join(root, 'libs', 'llama.cpp', 'llama-server.exe'));
    expect(fake.download).toHaveBeenCalledTimes(1);
    expect(existsSync(result!)).toBe(true);
  });

  it('并发多次调用只下载一次（幂等去重）', async () => {
    const fake = makeFakeDownloader({ createFile: true });
    const bridge = new ModelBridge(root, null, fake as never);

    const [r1, r2, r3] = await Promise.all([
      bridge.ensureBinary(),
      bridge.ensureBinary(),
      bridge.ensureBinary(),
    ]);

    expect(fake.download).toHaveBeenCalledTimes(1);
    expect(r1).toBeTruthy();
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it('下载失败返回 null，并发出 binary-error 事件；可重试', async () => {
    const fake = makeFakeDownloader({ fail: true });
    const bridge = new ModelBridge(root, null, fake as never);
    const onError = vi.fn();
    bridge.on('binary-error', onError);

    const first = await bridge.ensureBinary();
    expect(first).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fake.download).toHaveBeenCalledTimes(1);

    // 失败后允许重试：改用成功下载器可恢复
    const fake2 = makeFakeDownloader({ createFile: true });
    const bridge2 = new ModelBridge(root, null, fake2 as never);
    const result = await bridge2.ensureBinary();
    expect(result).toBeTruthy();
  });

  it('下载过程发出 downloading / progress / ready 事件', async () => {
    const fake = makeFakeDownloader({ createFile: true });
    const bridge = new ModelBridge(root, null, fake as never);
    const events: string[] = [];
    bridge.on('binary-downloading', () => events.push('downloading'));
    bridge.on('binary-progress', (pct) => events.push('progress:' + pct));
    bridge.on('binary-ready', (v) => events.push('ready:' + v));

    await bridge.ensureBinary();
    expect(events).toContain('downloading');
    expect(events).toContain('progress:50');
    expect(events).toContain('ready:b1234');
  });
});
