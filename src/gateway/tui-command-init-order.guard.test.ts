/**
 * 守卫测试：tui.ts 中「斜杠命令控制器」的初始化顺序。
 *
 * 背景（真实崩溃）：命令控制器（modelCmds / sessionCmds / compressCmds …）
 * 曾声明在斜杠二级菜单分支之后，而分支内会调用 handleSlashSubCommand 并
 * 在末尾 return —— 导致控制器永远不被初始化，用户选中任意子命令（如
 * /model/info）即触发 `ReferenceError: Cannot access 'modelCmds' before
 * initialization`（TDZ）。
 *
 * 本测试用源码行号断言防止该顺序被再次打乱：
 *   控制器声明行 < 斜杠分支入口行 < handleSlashSubCommand 定义行
 * 属静态守卫（不启动 TUI），与 extension-catalog.guard.test 同类。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TUI_PATH = path.resolve(__dirname, '../gateway/tui.ts');

function lineOf(source: string, pattern: RegExp): number {
  const idx = source.split('\n').findIndex((l) => pattern.test(l));
  return idx + 1; // 1-indexed
}

describe('tui 命令控制器初始化顺序守卫', () => {
  const src = fs.readFileSync(TUI_PATH, 'utf-8');

  const controllers = [
    'modelLocalCmds',
    'modelCmds',
    'compressCmds',
    'channelCmds',
    'channelDispatch',
    'sessionCmds',
  ];

  const slashBranchLine = lineOf(src, /if \(input\.startsWith\('\/'\)\)/);
  const handlerLine = lineOf(src, /async function handleSlashSubCommand/);

  it('斜杠分支与子命令处理器都存在于 tui.ts', () => {
    expect(slashBranchLine).toBeGreaterThan(0);
    expect(handlerLine).toBeGreaterThan(0);
  });

  for (const name of controllers) {
    it(`${name} 必须在斜杠二级菜单分支之前初始化（否则 TDZ）`, () => {
      const declLine = lineOf(src, new RegExp(`const ${name} = create`));
      expect(declLine).toBeGreaterThan(0);
      expect(declLine).toBeLessThan(slashBranchLine);
    });
  }

  it('handleSlashSubCommand 引用的控制器全部在其定义之前', () => {
    for (const name of controllers) {
      const declLine = lineOf(src, new RegExp(`const ${name} = create`));
      expect(declLine).toBeLessThan(handlerLine);
    }
  });
});
