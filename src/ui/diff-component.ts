/**
 * DiffComponent — 渲染文件变更 diff（TUI 中显示，模型不参与）
 *
 * 用单个 Text 组件渲染全部 diff 内容，避免 Container 子组件间距导致空行。
 */
import { Container, Text } from '@earendil-works/pi-tui';
import { theme } from './theme.js';

export interface DiffLineItem {
  kind: string;
  text: string;
}

const MAX_WIDTH = 76;

export class DiffComponent extends Container {
  constructor(filePath: string, lines: DiffLineItem[]) {
    super();

    const out: string[] = [];
    out.push(theme.accent(`── diff: ${filePath} ──`));

    const indent = '  '; // 2-space indent for visual separation
    const maxShow = 30;
    for (let i = 0; i < Math.min(lines.length, maxShow); i++) {
      const line = lines[i]!;
      const text = truncate(line.text, MAX_WIDTH);
      const display = indent + prefix(line.kind) + text;
      const colorFn = colorForKind(line.kind);
      out.push(colorFn(display));
    }
    if (lines.length > maxShow) {
      out.push(theme.dim(indent + `… 还有 ${lines.length - maxShow} 行`));
    }

    // 单 Text，多行，避免 Container 子组件间距
    this.addChild(new Text(out.join('\n')));
  }
}

function prefix(kind: string): string {
  return kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ';
}

function colorForKind(kind: string): (s: string) => string {
  return kind === 'add' ? theme.success
    : kind === 'del' ? theme.error
    : kind === 'header' ? theme.accent
    : theme.dim;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
