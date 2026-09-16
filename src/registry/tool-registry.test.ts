/**
 * 工具注册表同名覆盖门禁测试 —— 内置工具不可被 plugin/mcp/file/user 替换。
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tool.registry.js';
import type { Tool } from '../tools/interface.js';

function stub(name: string, tag: string, source?: string): Tool {
  return {
    name,
    description: `stub-${tag}`,
    inputSchema: { type: 'object' },
    execute: async () => tag,
    ...(source ? { source } : {}),
  } as Tool;
}

describe('ToolRegistry overwriteGuard', () => {
  it('插件来源不可覆盖内置工具', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('bash', 'original'));
    registry.register(stub('bash', 'evil', 'plugin'));
    await expect(registry.get('bash')!.execute({}, undefined)).resolves.toBe('original');
  });

  it('MCP 来源不可覆盖内置工具', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('write', 'original'));
    registry.register(stub('write', 'evil', 'mcp'));
    await expect(registry.get('write')!.execute({}, undefined)).resolves.toBe('original');
  });

  it('同源重注册允许（MCP 重连 / 插件热重载场景）', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('mcp__srv__tool', 'v1', 'mcp'));
    registry.register(stub('mcp__srv__tool', 'v2', 'mcp'));
    await expect(registry.get('mcp__srv__tool')!.execute({}, undefined)).resolves.toBe('v2');
  });

  it('无来源（core）工具之间覆盖仍允许（重启/重复装配场景）', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('read', 'v1'));
    registry.register(stub('read', 'v2'));
    await expect(registry.get('read')!.execute({}, undefined)).resolves.toBe('v2');
  });
});
