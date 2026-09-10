import type { Tool } from '../interface.js';
import type { RuntimeConfigCenter } from '../../runtime/config-center.js';

// Permission whitelist management tools (3)

/**
 * allow_tool — add a tool to the safety allowedTools whitelist.
 */
export function createAllowToolTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'allow_tool',
    description: '将工具加入安全白名单，加入后该工具不再需要用户确认即可执行。对危险工具列表中的工具同样生效。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to whitelist (e.g. "write", "bash")' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const toolName = args.name as string;
      if (!toolName) return 'Error: tool name is required.';

      try {
        const current = configCenter.get('safety.allowedTools') as unknown as string[] || [];
        if (current.includes(toolName)) {
          return `Tool "${toolName}" is already in the allowlist.`;
        }
        current.push(toolName);
        configCenter.set('safety.allowedTools', current);
        await configCenter.save();
        return `Tool "${toolName}" added to allowlist. It will no longer require confirmation (effective immediately).`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * disallow_tool — remove a tool from the safety allowedTools whitelist.
 */
export function createDisallowToolTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'disallow_tool',
    description: '将工具从安全白名单中移除。若该工具在危险工具列表中，恢复需要用户确认才能执行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to remove from the whitelist' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const toolName = args.name as string;
      if (!toolName) return 'Error: tool name is required.';

      try {
        const current = configCenter.get('safety.allowedTools') as unknown as string[] || [];
        const idx = current.indexOf(toolName);
        if (idx === -1) {
          return `Tool "${toolName}" is not in the allowlist.`;
        }
        current.splice(idx, 1);
        configCenter.set('safety.allowedTools', current);
        await configCenter.save();
        return `Tool "${toolName}" removed from allowlist. It will require confirmation again if it is in the dangerousTools list.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * list_allowlist — show current allowed tools and commands.
 */
export function createListAllowlistTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'list_allowlist',
    description: '查看当前安全白名单：allowedTools（免确认的工具列表）和 allowedCommands（免确认的 bash 命令模式列表）。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const tools = configCenter.get('safety.allowedTools') as unknown as string[] || [];
        const commands = configCenter.get('safety.allowedCommands') as unknown as string[] || [];

        const lines: string[] = ['=== Safety Whitelist ==='];
        lines.push(`\nAllowed Tools (skip confirmation):`);
        if (tools.length === 0) {
          lines.push('  (none)');
        } else {
          tools.forEach(t => lines.push(`  - ${t}`));
        }
        lines.push(`\nAllowed Commands (bash patterns, * = wildcard):`);
        if (commands.length === 0) {
          lines.push('  (none)');
        } else {
          commands.forEach(c => lines.push(`  - ${c}`));
        }
        lines.push(`\nUse allow_tool / disallow_tool to manage tools.`);
        lines.push(`Use agent config set safety.allowedCommands.+ "<pattern>" to add command patterns.`);
        return lines.join('\n');
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
