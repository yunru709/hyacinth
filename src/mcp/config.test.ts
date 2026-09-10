// ============================================================
// MCP 配置加载器测试
// ============================================================
// 重点守卫两个回归点：
//  1. 三处配置来源必须**合并**，不能「全局存在就跳过项目级」
//     （旧实现 early-return，导致 <project>/.agent/mcp.json 形同虚设）
//  2. setEnabled 必须回写到**声明该 Server 的那个文件**，
//     且被 _disabled 的条目仍要出现在 listEntries 里（UI 才能给开关）
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

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
  projectDir = path.join(tmpRoot, 'project');
  fakeHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.agent'), { recursive: true });
  // 劫持 os.homedir，让「用户级」配置落在临时目录
  (os as any).homedir = () => fakeHome;
});

afterEach(() => {
  (os as any).homedir = realHomedir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCPConfigLoader', () => {
  it('合并全局 + 项目级配置（旧实现会因 early-return 丢掉项目级）', async () => {
    writeJson(path.join(fakeHome, '.agent', 'mcp.json'), {
      mcpServers: { globalA: { command: 'node', args: ['a.js'] } },
    });
    writeJson(path.join(projectDir, '.mcp.json'), {
      mcpServers: { projB: { command: 'node', args: ['b.js'] } },
    });
    writeJson(path.join(projectDir, '.agent', 'mcp.json'), {
      mcpServers: { projC: { command: 'node', args: ['c.js'] } },
    });

    const configs = await new MCPConfigLoader().load(projectDir);
    const names = configs.map((c) => c.name).sort();
    expect(names).toEqual(['globalA', 'projB', 'projC']);
  });

  it('同名冲突时项目级覆盖全局', async () => {
    writeJson(path.join(fakeHome, '.agent', 'mcp.json'), {
      mcpServers: { dup: { command: 'node', args: ['global.js'] } },
    });
    writeJson(path.join(projectDir, '.agent', 'mcp.json'), {
      mcpServers: { dup: { command: 'node', args: ['project.js'] } },
    });

    const configs = await new MCPConfigLoader().load(projectDir);
    expect(configs.length).toBe(1);
    expect(configs[0].args).toEqual(['project.js']);
  });

  it('load 跳过 _disabled，但 listEntries 仍列出它们', async () => {
    writeJson(path.join(projectDir, '.agent', 'mcp.json'), {
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

  it('setEnabled 回写到声明它的那个文件，而非固定的全局文件', async () => {
    const globalFile = path.join(fakeHome, '.agent', 'mcp.json');
    const projectFile = path.join(projectDir, '.agent', 'mcp.json');
    writeJson(globalFile, { mcpServers: { g: { command: 'node' } } });
    writeJson(projectFile, { mcpServers: { p: { command: 'node' } } });

    const loader = new MCPConfigLoader();
    const touched = await loader.setEnabled(projectDir, 'p', false);
    expect(touched).toBe(projectFile);
    // 全局文件不应被动过
    expect(readJson(globalFile).mcpServers.g._disabled).toBeUndefined();
    expect(readJson(projectFile).mcpServers.p._disabled).toBe(true);

    // 再启用 → _disabled 被删除
    await loader.setEnabled(projectDir, 'p', true);
    expect(readJson(projectFile).mcpServers.p._disabled).toBeUndefined();

    // 禁用后 load 不再返回它
    await loader.setEnabled(projectDir, 'p', false);
    const configs = await loader.load(projectDir);
    expect(configs.map((c) => c.name)).toEqual(['g']);
  });

  it('setEnabled 找不到 Server → 抛错', async () => {
    writeJson(path.join(projectDir, '.agent', 'mcp.json'), { mcpServers: {} });
    await expect(new MCPConfigLoader().setEnabled(projectDir, 'ghost', true)).rejects.toThrow(/not found/);
  });

  it('拦截危险命令（bash/powershell 等）', async () => {
    writeJson(path.join(projectDir, '.agent', 'mcp.json'), {
      mcpServers: {
        evil: { command: 'bash', args: ['-c', 'rm -rf /'] },
        good: { command: 'npx', args: ['-y', 'something'] },
      },
    });
    const configs = await new MCPConfigLoader().load(projectDir);
    expect(configs.map((c) => c.name)).toEqual(['good']);
  });
});
