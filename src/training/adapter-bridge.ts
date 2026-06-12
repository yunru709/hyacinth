import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ModelBridge } from '../local-model/model-bridge.js';

export interface LoadedAdapter {
  name: string;
  path: string;
  scale: number;
}

export class AdapterBridge {
  private modelBridge: ModelBridge;
  private adapterDir: string;

  constructor(modelBridge: ModelBridge, adapterDir: string) {
    this.modelBridge = modelBridge;
    this.adapterDir = adapterDir;
  }

  async loadAdapter(name: string, scale?: number): Promise<boolean> {
    const adapterPath = this.resolveAdapterPath(name);
    if (!adapterPath) return false;

    const addr = this.getServerAddress();
    if (!addr) return false;

    const effectiveScale = scale ?? 1.0;

    try {
      const response = await fetch(`http://${addr.host}:${addr.port}/lora-adapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ name, path: adapterPath, scale: effectiveScale }]),
      });
      if (response.ok) return true;
      if (response.status !== 404) return false;
    } catch {}

    return this.fallbackLoad(adapterPath, effectiveScale);
  }

  async unloadAdapter(name: string): Promise<boolean> {
    const addr = this.getServerAddress();
    if (!addr) return false;

    try {
      const response = await fetch(`http://${addr.host}:${addr.port}/lora-adapters/${name}`, {
        method: 'DELETE',
      });
      if (response.ok) return true;
      if (response.status !== 404) return false;
    } catch {}

    return this.fallbackUnload();
  }

  async listLoadedAdapters(): Promise<LoadedAdapter[]> {
    const addr = this.getServerAddress();
    if (!addr) return [];

    try {
      const response = await fetch(`http://${addr.host}:${addr.port}/lora-adapters`);
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) return data as LoadedAdapter[];
      }
    } catch {}

    return [];
  }

  private resolveAdapterPath(name: string): string | null {
    const candidates = [
      join(this.adapterDir, `${name}.gguf`),
      join(this.adapterDir, 'adapters', `${name}.gguf`),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private getServerAddress(): { host: string; port: string } | null {
    const activeModel = this.modelBridge.getActiveModel();
    if (!activeModel) return null;

    const pm = this.modelBridge.getProcessManager(activeModel);
    if (!pm) return null;

    const args = pm.config.args ?? [];
    const portIdx = args.indexOf('--port');
    const hostIdx = args.indexOf('--host');

    return {
      host: hostIdx !== -1 && hostIdx + 1 < args.length ? args[hostIdx + 1] : '127.0.0.1',
      port: portIdx !== -1 && portIdx + 1 < args.length ? args[portIdx + 1] : '8080',
    };
  }

  private async fallbackLoad(adapterPath: string, scale: number): Promise<boolean> {
    const activeModel = this.modelBridge.getActiveModel();
    if (!activeModel) return false;

    const pm = this.modelBridge.getProcessManager(activeModel);
    if (!pm?.config.args) return false;

    if (scale === 1.0) {
      pm.config.args.push('--lora', adapterPath);
    } else {
      pm.config.args.push('--lora-scaled', adapterPath, String(scale));
    }

    try {
      await pm.restart();
      return true;
    } catch {
      return false;
    }
  }

  private async fallbackUnload(): Promise<boolean> {
    const activeModel = this.modelBridge.getActiveModel();
    if (!activeModel) return false;

    const pm = this.modelBridge.getProcessManager(activeModel);
    if (!pm?.config.args) return false;

    const cleaned = this.stripLoraArgs(pm.config.args);
    pm.config.args.length = 0;
    pm.config.args.push(...cleaned);

    try {
      await pm.restart();
      return true;
    } catch {
      return false;
    }
  }

  private stripLoraArgs(args: string[]): string[] {
    const result: string[] = [];
    let i = 0;
    while (i < args.length) {
      if (args[i] === '--lora' && i + 1 < args.length) {
        i += 2;
      } else if (args[i] === '--lora-scaled' && i + 2 < args.length) {
        i += 3;
      } else {
        result.push(args[i]);
        i++;
      }
    }
    return result;
  }
}
