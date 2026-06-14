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

  // normalize line endings
  const oldNorm = oldText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const newNorm = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const changes = diffLines(oldNorm, newNorm, { ignoreNewlineAtEof: true });

  let oldLine = 1;
  let newLine = 1;
  let totalNonHeader = 0;

  for (const change of changes) {
    // remove trailing newline then split
    const raw = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
    const lines = raw.split('\n').map(l => l.trimEnd()); // strip \r and trailing spaces
    for (const line of lines) {
      totalNonHeader++;
      if (change.added) {
        result.push({ kind: 'add', text: line, newLine: newLine++ });
      } else if (change.removed) {
        result.push({ kind: 'del', text: line, oldLine: oldLine++ });
      } else {
        result.push({ kind: 'context', text: line, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }

  // 折叠
  if (totalNonHeader > MAX_LINES) {
    const preview = result.slice(0, PREVIEW_LINES);
    preview.push({
      kind: 'context',
      text: `… 还有 ${totalNonHeader - PREVIEW_LINES} 行（折叠）`,
    });
    return preview;
  }

  return result;
}
