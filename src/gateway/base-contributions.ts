/**
 * base-contributions.ts —— P-A 基础装配贡献批（行数收尾 · P-A 第一小批）。
 *
 * 迁移 P-A 中「创建集中、无早期接线」的 4 类：gitManager / turnStore /
 * turnRecorder（依赖 gitManager+turnStore）/ flowRegistry。ConfigManager /
 * SessionManager 因 config.load() 与 session 恢复逻辑深度接线，暂留 factory。
 *
 * 与 core-contributions.ts 同模式：贡献点分布在依赖就绪的时序点，白名单随
 * 迁出逐条下降（只减不增）。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { GitManager } from '../evolution/git-manager.js';
import { TurnStore, TurnRecorder } from '../rollback/index.js';
import { MachineRegistry, TodoFlow, SpecFlow } from '../machine/index.js';

export interface BaseContributionDeps {
  cwd: string;
  rollbackDir: string;
}

/** 执行 P-A 基础贡献批（gitManager / turnStore / turnRecorder / flowRegistry） */
export async function runBaseContributions(
  deps: BaseContributionDeps,
): Promise<AssemblyResults> {
  const runner = new AssemblyRunner();
  runner.provide('cwd', deps.cwd);
  runner.provide('rollbackDir', deps.rollbackDir);
  return runner.run([
    {
      id: 'gitManager',
      needs: ['cwd'],
      provides: ['gitManager'],
      mount: ({ cwd }) => ({ gitManager: new GitManager(cwd as string) }),
    },
    {
      id: 'turnStore',
      needs: ['rollbackDir'],
      provides: ['turnStore'],
      mount: ({ rollbackDir }) => ({ turnStore: new TurnStore(rollbackDir as string) }),
    },
    {
      id: 'turnRecorder',
      needs: ['gitManager', 'turnStore', 'cwd'],
      provides: ['turnRecorder'],
      mount: (d) => ({
        turnRecorder: new TurnRecorder(
          d.gitManager as GitManager,
          d.turnStore as TurnStore,
          d.cwd as string,
        ),
      }),
    },
    {
      id: 'flowRegistry',
      needs: [],
      provides: ['flowRegistry'],
      mount: () => {
        const flowRegistry = new MachineRegistry();
        // 内置 Flow 注册随批迁入（原 factory 两行 register）
        flowRegistry.register(new TodoFlow());
        flowRegistry.register(new SpecFlow());
        return { flowRegistry };
      },
    },
  ]);
}
