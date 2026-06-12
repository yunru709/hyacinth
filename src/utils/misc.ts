/**
 * 通用工具函数 — 各模块共用的零依赖 helper。
 *
 * 提取自 dependency/analyzer.ts、memory/session.ts、gateway/cli.ts、
 * training/aggregator.ts、training/scheduler.ts 中的重复实现。
 */

/** 将工作目录路径归一化为项目标识（projectKey） */
export function toProjectKey(cwd: string): string {
  const normalized = cwd.replace(/[/\\]+/g, '-');
  return normalized.replace(/^[-]+|[-]+$/g, '').replace(/:/g, '');
}

/** 日期格式化为 YYYY-MM-DD */
export function formatDate(date?: Date): string {
  const d = date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
