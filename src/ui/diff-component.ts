/**
 * DiffComponent — 渲染文件变更 diff（TUI 中显示，模型不参与）
 */
import { Container, Text } from '@earendil-works/pi-tui';
import { theme } from './theme.js';

export interface DiffLineItem {
  kind: string;
  text: string;
}

const MAX_WIDTH = 80;

export class DiffComponent extends Container {
  constructor(filePath: string, lines: DiffLineItem[]) {
    super();

    // pi-tui Text: new Text(text, x?, y?)
    this.addChild(new Text(theme.dim(`── diff: ${filePath} ──`), 0, 0));

    let y = 1;
    const maxShow = 30;
    for (let i = 0; i < Math.min(lines.length, maxShow); i++) {
      const line = lines[i]!;
      const text = truncate(line.text, MAX_WIDTH);
      const display = prefix(line.kind) + text;
      const colorFn = colorForKind(line.kind);
      this.addChild(new Text(colorFn(display), 0, y));
      y++;
    }
    if (lines.length > maxShow) {
      this.addChild(new Text(theme.dim(`… 还有 ${lines.length - maxShow} 行`), 0, y));
    }
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
