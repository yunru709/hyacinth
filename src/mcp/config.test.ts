// ============================================================
// MCP 配置加载器测试
// ============================================================
// P-Config 收敛后 MCP 配置统一走全局 ~/.agent/mcp.json（项目级已取消），
// 重点守卫：
//  1. load 从全局文件读取并跳过 _disabled
//  2. setEnabled 回写到全局文件，且被 _disabled 的条目仍出现在 listEntries
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCPConfigLoader } from './config.js';

let tmpRoot: string;
let projectDir: string;
let fakeHome: string;
const realHomedir = os.homedir;

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function globalMcpFile(): string {
  return path.join(fakeHome, '.agent', 'mcp.json');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
  projectDir = path.join(tmpRoot, 'project');
  fakeHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.agent'), { recursive: true });
  // 劫持 os.homedir，让全局配置落在临时目录
  (os as any).homedir = () => fakeHome;
});

afterEach(() => {
  (os as any).homedir = realHomedir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCPConfigLoader', () => {
  it('只读全局 mcp.json（项目级已取消，不再合并项目文件）', async () => {
    writeJson(globalMcpFile(), {
      mcpServers: { globalA: { command: 'node', args: ['a.js'] } },
    });
    // 项目级文件存在也不应被读取（P-Config 收敛）
    writeJson(path.join(projectDir, '.mcp.json'), {
      mcpServers: { projB: { command: 'node', args: ['b.js'] } },
    });
    writeJson(path.join(projectDir, '.agent', 'mcp.json'), {
      mcpServers: { projC: { command: 'node', args: ['c.js'] } },
    });

    const configs = await new MCPConfigLoader().load(projectDir);
    const names = configs.map((c) => c.name).sort();
    expect(names).toEqual(['globalA']);
  });

  it('load 跳过 _disabled，但 listEntries 仍列出它们', async () => {
    writeJson(globalMcpFile(), {
      mcpServers: {
        on: { command: 'node' },
        off: { command: 'node', _disabled: true },
      },
    });

    const loader = new MCPConfigLoader();
    const configs = await loader.load(projectDir);
    expect(configs.map((c) => c.name)).toEqual(['on']);

    const entries = await loader.listEntries(projectDir);
    expect(entries.map((e) => e.name).sort()).toEqual(['off', 'on']);
    expect(entries.find((e) => e.name === 'off')?.enabled).toBe(false);
    expect(entries.find((e) => e.name === 'on')?.enabled).toBe(true);
  });

  it('setEnabled 回写到全局 mcp.json', async () => {
    const globalFile = globalMcpFile();
    writeJson(globalFile, { mcpServers: { g: { command: 'node' }, p: { command: 'node' } } });

    const loader = new MCPConfigLoader();
    const touched = await loader.setEnabled(projectDir, 'p', false);
    expect(touched).toBe(globalFile);
    expect(readJson(globalFile).mcpServers.g._disabled).toBeUndefined();
    expect(readJson(globalFile).mcpServers.p._disabled).toBe(true);

    // 再启用 → _disabled 被删除
    await loader.setEnabled(projectDir, 'p', true);
    expect(readJson(globalFile).mcpServers.p._disabled).toBeUndefined();

    // 禁用后 load 不再返回它
    await loader.setEnabled(projectDir, 'p', false);
    const configs = await loader.load(projectDir);
    expect(configs.map((c) => c.name)).toEqual(['g']);
  });

  it('setEnabled 找不到 Server → 抛错', async () => {
    writeJson(globalMcpFile(), { mcpServers: {} });
    await expect(new MCPConfigLoader().setEnabled(projectDir, 'ghost', true)).rejects.toThrow(/not found/);
  });

  it('拦截危险命令（bash/powershell 等）', async () => {
    writeJson(globalMcpFile(), {
      mcpServers: {
        evil: { command: 'bash', args: ['-c', 'rm -rf /'] },
        good: { command: 'npx', args: ['-y', 'something'] },
      },
    });
    const configs = await new MCPConfigLoader().load(projectDir);
    expect(configs.map((c) => c.name)).toEqual(['good']);
  });
});
