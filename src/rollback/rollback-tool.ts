/**
 * 回滚工具 — rollback_status + rollback
 *
 * 两个独立工具，通过工厂函数创建：
 *   - createRollbackStatusTool: 查看可回滚的回合列表
 *   - createRollbackTool: 执行回滚操作
 */

import type { Tool } from '../tools/interface.js';
import type { TurnStore } from './turn-store.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { RollbackStatusEntry } from './types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('rollback-tool');

// ── rollback_status ──────────────────────────────────────────────────

export function createRollbackStatusTool(
  turnStore: TurnStore,
  getCurrentTurn: () => number,
): Tool {
  return {
    name: 'rollback_status',
    description:
      'View the list of turns available for rollback. Each turn shows its ID, timestamp, ' +
      'number of changed files, and executed commands. Use this before calling rollback to ' +
      'decide how many turns to roll back.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },

    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const records = await turnStore.list();
        const currentTurn = getCurrentTurn();

        if (records.length === 0) {
          return 'No turns available for rollback. Turns are recorded as you interact with the agent.';
        }

        const entries: RollbackStatusEntry[] = records.map(r => {
          const fileNames = r.changedFiles.slice(0, 3).map(f => f.path);
          const extra = r.changedFiles.length > 3 ? ` (+${r.changedFiles.length - 3} more)` : '';
          return {
            turnId: r.turnId,
            timestamp: r.timestamp,
            fileCount: r.changedFiles.length,
            commandCount: r.commands.length,
            fileSummary: fileNames.join(', ') + extra,
          };
        });

        const lines = [
          `Current turn: ${currentTurn} | Stored turns: ${records.length} (max 20)`,
          '',
          'Available rollback points:',
        ];

        for (const e of entries) {
          const marker = e.turnId === currentTurn ? ' ← current' : '';
          lines.push(`  Turn ${e.turnId}${marker}`);
          lines.push(`    ${e.timestamp}`);
          lines.push(`    Files: ${e.fileCount} (${e.fileSummary || 'none'})`);
          if (e.commandCount > 0) {
            lines.push(`    Commands: ${e.commandCount}`);
          }
          lines.push('');
        }

        lines.push('Use rollback({turns: N}) to roll back N turns.');

        return lines.join('\n');
      } catch (err) {
        return `Error reading rollback status: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── rollback ─────────────────────────────────────────────────────────

export function createRollbackTool(
  turnStore: TurnStore,
  gitManager: GitManager,
  getCurrentTurn: () => number,
): Tool {
  return {
    name: 'rollback',
    description:
      'Roll back file changes made in the last N turns. ' +
      'Uses git to restore files to their state before the target turn. ' +
      'Only file changes are reverted; configuration changes may need manual review. ' +
      'Use rollback_status first to see available turns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        turns: {
          type: 'number' as const,
          description: 'Number of turns to roll back (default: 1, range: 1-10). ' +
            'Rollback(1) reverts the most recent turn.',
        },
      },
      required: [],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const turns = (args.turns as number) ?? 1;

      if (turns < 1 || turns > 10) {
        return 'Error: "turns" must be between 1 and 10.';
      }

      try {
        const currentTurn = getCurrentTurn();
        const records = await turnStore.list();

        if (records.length === 0) {
          return 'No turns available to roll back.';
        }

        // 找到目标回合：回退 N 回合 → currentTurn - N + 1
        const targetTurnId = currentTurn - turns + 1;

        // 找到最近的 ≤ targetTurnId 的已存储回合
        const targetRecord = records
          .filter(r => r.turnId <= targetTurnId)
          .sort((a, b) => b.turnId - a.turnId)[0];

        if (!targetRecord) {
          // 如果目标回合未存储，回退到最早的已存储回合
          const earliest = records.sort((a, b) => a.turnId - b.turnId)[0];
          return `Target turn ${targetTurnId} is not stored (oldest available: ${earliest.turnId}). ` +
            `Use rollback_status to see available turns.`;
        }

        // 收集将要被回滚的回合信息（用于报告）
        const rolledBackTurns = records.filter(r => r.turnId > targetRecord.turnId);

        // ── 执行回滚 ──
        if (targetRecord.preCommit) {
          // 有 git commit → 精确恢复
          try {
            await gitManager.resetHard(targetRecord.preCommit);
            logger.info(`Rolled back to turn ${targetRecord.turnId} (preCommit: ${targetRecord.preCommit.slice(0, 8)})`);
          } catch (err) {
            return `Git rollback failed: ${err instanceof Error ? err.message : String(err)}\n` +
              `Try manually: git reset --hard ${targetRecord.preCommit.slice(0, 8)}`;
          }

          // 清理 tag
          for (const r of rolledBackTurns) {
            try {
              await gitManager.git(['tag', '-d', `rollback-turn-${r.turnId}`]);
            } catch {
              // tag 可能不存在，忽略
            }
          }
        } else {
          return 'Cannot roll back: no git repository detected. ' +
            'Git-based rollback requires a git repository in the project directory.';
        }

        // ── 清理缓存 ──
        await turnStore.deleteRange(targetRecord.turnId + 1);

        // ── 构建报告 ──
        const totalFiles = rolledBackTurns.reduce((sum, r) => sum + r.changedFiles.length, 0);
        const allFiles = rolledBackTurns.flatMap(r => r.changedFiles.map(f => f.path));
        const uniqueFiles = [...new Set(allFiles)];

        const fileList = uniqueFiles.slice(0, 10)
          .map(f => `  • ${f}`)
          .join('\n');

        const extraFiles = uniqueFiles.length > 10
          ? `\n  ... and ${uniqueFiles.length - 10} more files`
          : '';

        const allCommands = rolledBackTurns.flatMap(r => r.commands);
        const cmdLines = allCommands.length > 0
          ? `\n\n💡 ${rolledBackTurns.length} rolled-back turn(s) executed these commands — please check for side effects:\n` +
            allCommands.map(c => `  • ${c}`).join('\n')
          : '';

        const lines = [
          `🔄 Rolled back ${turns} turn(s) to turn ${targetRecord.turnId} (before the reverted changes).`,
          '',
          `✅ ${uniqueFiles.length} file(s) restored across ${rolledBackTurns.length} turn(s):`,
          fileList + extraFiles,
          cmdLines,
          '',
          `💡 If there were config changes (channels, settings, etc.), please check and fix them manually.`,
        ];

        return lines.join('\n');
      } catch (err) {
        return `Rollback error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
