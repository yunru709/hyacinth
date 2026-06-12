import { Box, Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { markdownTheme, theme } from './theme.js';
import { resolveToolDisplay, formatToolSummary } from './tool-display.js';
import { sanitizeRenderableText } from './tui-formatters.js';

const PREVIEW_LINES = 12;

function formatArgs(toolName: string, args: unknown): string {
  const display = resolveToolDisplay({ name: toolName, args });
  const summary = formatToolSummary(display);
  return sanitizeRenderableText(summary);
}

function extractText(result?: string): string {
  if (!result) return '';
  return sanitizeRenderableText(result);
}

export class ToolExecutionComponent extends Container {
  private box: Box;
  private header: Text;
  private argsLine: Text;
  private output: Markdown;
  private toolName: string;
  private args: unknown;
  private result?: string;
  private expanded = false;
  private isError = false;
  private isPartial = true;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
    this.header = new Text('', 0, 0);
    this.argsLine = new Text('', 0, 0);
    this.output = new Markdown('', 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.refresh();
  }

  setArgs(args: unknown) {
    this.args = args;
    this.refresh();
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.refresh();
  }

  setResult(result: string | undefined, opts?: { isError?: boolean }) {
    this.result = result;
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.refresh();
  }

  setPartialResult(result: string | undefined) {
    this.result = result;
    this.isPartial = true;
    this.refresh();
  }

  private refresh() {
    const bg = this.isPartial
      ? theme.toolPendingBg
      : this.isError
        ? theme.toolErrorBg
        : theme.toolSuccessBg;
    this.box.setBgFn((line) => bg(line));

    const display = resolveToolDisplay({ name: this.toolName, args: this.args });
    const title = `${display.emoji} ${display.label}${this.isPartial ? ' (running)' : ''}`;
    this.header.setText(theme.toolTitle(theme.bold(title)));

    const argLine = formatArgs(this.toolName, this.args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(' '));

    const raw = extractText(this.result);
    const text = raw || (this.isPartial ? '\u2026' : '');
    if (!this.expanded && text) {
      const lines = text.split('\n');
      const preview =
        lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n\u2026` : text;
      this.output.setText(preview);
    } else {
      this.output.setText(text);
    }
  }
}
