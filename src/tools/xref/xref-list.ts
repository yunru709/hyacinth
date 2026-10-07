/**
 * xref_list — 列出 / 清理所有项目的交叉引用索引。
 *
 * 为什么需要它：索引库按项目分开存放（`xref-<项目键>.sqlite`），但此前**没有任何
 * 工具入口**能让模型看到全局 —— "某个项目的索引该清了""磁盘被索引吃了多少"这类事
 * 只能靠人手动翻 cache 目录。清理能力（manager.deleteDatabase）本来就在，缺的是
 * 一个能被看见、能被调用的入口。
 *
 * 与 diagnostics/doctor.ts「xref cache 体检」的分工：那是 doctor 命令的体检报告
 * （含自动回收孤儿）；这里是工具面，供按需查看与定点清理。
 */

import type { Tool } from '../interface.js';
import type { XrefManager } from './manager.js';
import { listXrefIndexes, readRememberedRoot } from './project-root.js';

export class XrefListTool implements Tool {
  readonly name = 'xref_list';
  readonly description =
    '列出本机所有项目的交叉引用索引库（每个项目一个独立库，互不覆盖），并可定点清理。\n\n' +
    '显示：项目根目录、占用空间、最近使用时间、状态标记：\n' +
    '  [根已消失] —— 那个目录已经不存在了，库是废的，可回收\n' +
    '  [根在禁区] —— 根落在主目录/盘符根（历史事故残留形态），建议回收\n' +
    '  * 号 —— 当前项目（上次建索引记住的那个）\n\n' +
    '清理：传 clean="<项目根路径 或 项目键>" 删除该项目的索引库（下次查询需重建）。\n' +
    '不带参数 = 只列出，不删除任何东西。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      clean: {
        type: 'string',
        description:
          '要删除的项目的根路径（或项目键，见列表里的"键"）。' +
          '省略时只列出，不删除任何东西。',
      },
    },
    required: [],
  };

  private manager: XrefManager;

  constructor(manager: XrefManager) {
    this.manager = manager;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const clean = args.clean as string | undefined;
    if (clean && clean.trim()) {
      // deleteDatabase 不依赖"当前已打开的库" ⇒ 即使 manager 未绑根也能清指定项目
      return await this.manager.deleteDatabase(clean.trim());
    }

    const entries = listXrefIndexes();
    if (entries.length === 0) {
      return '还没有任何项目的交叉引用索引。用 xref_build（首次记得带 root 参数指定项目目录）建一个。';
    }

    const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
    const active = readRememberedRoot();
    const lines: string[] = [
      `共 ${entries.length} 个索引库，合计 ${mb(entries.reduce((a, e) => a + e.bytes, 0))}：`,
      '',
    ];
    for (const e of entries) {
      const isActive = !!active && !!e.rootDir && e.rootDir === active;
      const mark = e.orphan ? '  [根已消失]' : e.suspectRoot ? '  [根在禁区]' : '';
      lines.push(
        `${isActive ? '*' : ' '} ${e.rootDir || '(根未知：库被占用或已损坏)'}${mark}`,
        `      ${mb(e.bytes).padStart(10)}   最后使用 ${e.lastUsedAt || '未知'}   键=${e.key}`,
      );
    }
    lines.push('', '清理某个项目：xref_list clean="<上面第一列的路径>"');
    return lines.join('\n');
  }
}
