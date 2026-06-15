/**
 * 工具包管理工具 — list / activate / deactivate / create / add / remove / delete
 *
 * 从 factory.ts 中提取，统一注册到 ToolRegistry。
 */

import type { Tool } from './interface.js';
import type { ToolBundleRegistry } from './bundle-registry.js';

export function registerBundleTools(
  toolRegistry: { register(tool: Tool): void },
  bundleRegistry: ToolBundleRegistry,
): void {
  const tools: Tool[] = [
    {
      name: 'list_bundles',
      description: 'List all available tool bundles with their tools and activation status.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        try {
          const bundles = bundleRegistry.list();
          const activeNames = new Set(bundleRegistry.getActive().map(b => b.name));
          const lines = bundles.map(b => {
            const marker = activeNames.has(b.name) ? ' [已激活]' : '';
            const toolList = b.tools.length > 0 ? b.tools.join(', ') : '(全量)';
            return `- ${b.name}: ${b.description}${marker}\n  工具: ${toolList}`;
          });
          return lines.length > 0 ? lines.join('\n\n') : '(无工具包)';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'activate_bundle',
      description: 'Activate one or more tool bundles (comma-separated names). Use deactivate_bundle to return to full mode.',
      inputSchema: {
        type: 'object',
        properties: {
          names: { type: 'string', description: '工具包名称，多个用逗号分隔。传 "all" 或留空 = 全量模式。' },
        },
        required: [],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const raw = typeof args.names === 'string' ? args.names.trim() : '';
          if (!raw || raw === 'all') {
            bundleRegistry.deactivate();
            return '已切换至全量模式，所有工具可用';
          }
          const names = raw.split(',').map(s => s.trim()).filter(Boolean);
          bundleRegistry.activate(names);
          const count = bundleRegistry.getActiveToolNames().length;
          return `已激活 ${names.length} 个工具包（${count} 个工具去重并集），下一轮生效`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'deactivate_bundle',
      description: 'Deactivate all bundles and return to full tool mode.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        try {
          bundleRegistry.deactivate();
          return '已取消所有工具包限制，回到全量模式';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'create_bundle',
      description: 'Create a new tool bundle.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工具包名称' },
          description: { type: 'string', description: '工具包描述' },
          tools: { type: 'array', items: { type: 'string' }, description: '工具名称列表' },
        },
        required: ['name', 'description'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const name = String(args.name);
          const desc = String(args.description);
          const tools = (Array.isArray(args.tools) ? args.tools : []) as string[];
          bundleRegistry.create(name, desc, tools);
          return `工具包 "${name}" 已创建（${tools.length} 个工具），使用 activate_bundle 激活`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'add_to_bundle',
      description: 'Add tools to an existing bundle.',
      inputSchema: {
        type: 'object',
        properties: {
          bundle: { type: 'string', description: '目标工具包名称' },
          tools: { type: 'array', items: { type: 'string' }, description: '要追加的工具名称列表' },
        },
        required: ['bundle', 'tools'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const bundleName = String(args.bundle);
          const toolNames = (Array.isArray(args.tools) ? args.tools : []) as string[];
          bundleRegistry.addTools(bundleName, toolNames);
          const b = bundleRegistry.get(bundleName);
          return `已向 "${bundleName}" 追加 ${toolNames.length} 个工具，当前共 ${b?.tools?.length ?? 0} 个`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'remove_from_bundle',
      description: 'Remove tools from a bundle.',
      inputSchema: {
        type: 'object',
        properties: {
          bundle: { type: 'string', description: '目标工具包名称' },
          tools: { type: 'array', items: { type: 'string' }, description: '要移除的工具名称列表' },
        },
        required: ['bundle', 'tools'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const bundleName = String(args.bundle);
          const toolNames = (Array.isArray(args.tools) ? args.tools : []) as string[];
          bundleRegistry.removeTools(bundleName, toolNames);
          const b = bundleRegistry.get(bundleName);
          return b
            ? `已从 "${bundleName}" 移除 ${toolNames.length} 个工具，当前共 ${b.tools.length} 个`
            : `"${bundleName}" 不存在`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'delete_bundle',
      description: 'Delete a tool bundle (builtin and common cannot be deleted).',
      inputSchema: {
        type: 'object',
        properties: { bundle: { type: 'string', description: '要删除的工具包名称' } },
        required: ['bundle'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        try {
          const bundleName = String(args.bundle);
          bundleRegistry.delete(bundleName);
          return `工具包 "${bundleName}" 已删除`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];

  for (const tool of tools) {
    toolRegistry.register(tool);
  }
}
