import type { Tool } from './interface.js';
import { collectSystemInfo, type SystemEnvInfo } from '../env/env-collector.js';

let cachedInfo: SystemEnvInfo | null = null;

function formatSystemInfo(info: SystemEnvInfo, categories?: string[]): string {
  const all = !categories || categories.length === 0 || categories.includes('all');
  const want = (k: string) => all || categories.includes(k);
  const lines: string[] = ['System Environment:'];

  if (want('os')) {
    lines.push(`- OS: ${info.os} (${info.arch})`);
  }
  if (want('cpu')) {
    lines.push(`- CPU: ${info.cpuModel} (${info.cpuCores} cores)`);
  }
  if (want('memory')) {
    lines.push(`- Memory: ${info.totalMemoryGB} GB`);
  }
  if (want('gpu')) {
    lines.push(`- GPU: ${info.gpu}`);
  }
  if (want('python')) {
    lines.push(`- Python: ${info.python}`);
  }
  if (want('node')) {
    lines.push(`- Node.js: ${info.nodeVersion}`);
  }
  if (want('shell')) {
    lines.push(`- Shell: ${info.shell}`);
  }

  return lines.join('\n');
}

export function createSystemInfoTool(): Tool {
  return {
    name: 'system_info',
    description:
      '查询当前系统环境信息：操作系统、CPU、内存、GPU、Python/Node.js 版本、Shell 类型等。适用于跨平台开发、性能调优或安装依赖时参考。',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['os', 'cpu', 'memory', 'gpu', 'python', 'node', 'shell', 'all'],
          },
          description: 'Categories to query. Default: all.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      if (!cachedInfo) {
        cachedInfo = collectSystemInfo();
      }
      return formatSystemInfo(cachedInfo, args.categories as string[] | undefined);
    },
  };
}
