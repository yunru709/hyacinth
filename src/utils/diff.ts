/**
 * 文件 diff 计算工具
 * 使用 diff 包做行级 unified diff，供 TUI 渲染，不进入模型 context
 */
import { diffLines } from 'diff';

export type DiffLineKind = 'header' | 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const MAX_LINES = 50;       // 超过此行数折叠
const PREVIEW_LINES = 20;   // 折叠时预览前 N 行

export function computeDiff(
  oldText: string,
  newText: string,
  filePath: string,
): DiffLine[] {
  const result: DiffLine[] = [];

  // header
  result.push({ kind: 'header', text: `--- a/${filePath}` });
  result.push({ kind: 'header', text: `+++ b/${filePath}` });

  const changes = diffLines(oldText, newText, { ignoreNewlineAtEof: true });

  let oldLine = 1;
  let newLine = 1;
  let totalNonHeader = 0;

  for (const change of changes) {
    const lines = change.value.replace(/\n$/, '').split('\n');
    if (change.added) {
      for (const line of lines) {
        totalNonHeader++;
        result.push({ kind: 'add', text: line, newLine: newLine++ });
      }
    } else if (change.removed) {
      for (const line of lines) {
        totalNonHeader++;
        result.push({ kind: 'del', text: line, oldLine: oldLine++ });
      }
    } else {
      for (const line of lines) {
        totalNonHeader++;
        result.push({ kind: 'context', text: line, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }

  // 折叠
  if (totalNonHeader > MAX_LINES) {
    const headerLines = 2; // --- and +++
    const preview = result.slice(0, headerLines + PREVIEW_LINES);
    preview.push({
      kind: 'context',
      text: `… 还有 ${totalNonHeader - PREVIEW_LINES} 行（折叠）`,
    });
    return preview;
  }

  return result;
}
