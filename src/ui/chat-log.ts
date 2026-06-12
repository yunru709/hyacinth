import type { Component } from '@earendil-works/pi-tui';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';
import { theme } from './theme.js';
import { AssistantMessageComponent } from './assistant-message.js';
import { ToolExecutionComponent } from './tool-execution.js';
import { UserMessageComponent } from './user-message.js';

const MAX_COMPONENTS = 200;

type RepeatableSystemMessage = {
  component: Container;
  textNode: Text;
  baseText: string;
  count: number;
};

export class ChatLog extends Container {
  private readonly maxComponents: number;
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private toolsExpanded = false;
  private repeatableSystemMessage: RepeatableSystemMessage | null = null;
  private _scrollOffset = 0;
  private _viewportHeight = 40;

  constructor(maxComponents = MAX_COMPONENTS) {
    super();
    this.maxComponents = Math.max(20, Math.floor(maxComponents));
  }

  private dropComponentReferences(component: Component) {
    for (const [toolId, tool] of this.toolById.entries()) {
      if (tool === component) this.toolById.delete(toolId);
    }
    for (const [runId, message] of this.streamingRuns.entries()) {
      if (message === component) this.streamingRuns.delete(runId);
    }
    if (this.repeatableSystemMessage?.component === component) {
      this.repeatableSystemMessage = null;
    }
  }

  private pruneOverflow() {
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) return;
      this.removeChild(oldest);
      this.dropComponentReferences(oldest);
    }
  }

  private append(component: Component) {
    this.addChild(component);
    this.pruneOverflow();
  }

  private appendNonSystem(component: Component) {
    this.repeatableSystemMessage = null;
    this.append(component);
  }

  private formatRepeatedSystemText(text: string, count: number) {
    return count > 1 ? `${text} x${count}` : text;
  }

  private createSystemMessage(text: string): RepeatableSystemMessage {
    const entry = new Container();
    const textNode = new Text(theme.system(text), 1, 0);
    entry.addChild(new Spacer(1));
    entry.addChild(textNode);
    return { component: entry, textNode, baseText: text, count: 1 };
  }

  addSystem(text: string, opts?: { coalesceConsecutive?: boolean }) {
    if (
      opts?.coalesceConsecutive &&
      this.repeatableSystemMessage?.baseText === text &&
      this.children[this.children.length - 1] === this.repeatableSystemMessage.component
    ) {
      this.repeatableSystemMessage.count += 1;
      this.repeatableSystemMessage.textNode.setText(
        theme.system(this.formatRepeatedSystemText(text, this.repeatableSystemMessage.count)),
      );
      return;
    }
    const message = this.createSystemMessage(text);
    this.append(message.component);
    this.repeatableSystemMessage = opts?.coalesceConsecutive ? message : null;
  }

  addUser(text: string) {
    this.appendNonSystem(new UserMessageComponent(text));
  }

  private resolveRunId(runId?: string) {
    return runId ?? 'default';
  }

  startAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(text);
      return existing;
    }
    const component = new AssistantMessageComponent(text);
    this.streamingRuns.set(effectiveRunId, component);
    this.appendNonSystem(component);
    return component;
  }

  updateAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(text);
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(text);
      this.streamingRuns.delete(effectiveRunId);
      return;
    }
    this.appendNonSystem(new AssistantMessageComponent(text));
  }

  dropAssistant(runId?: string) {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) return;
    this.removeChild(existing);
    this.streamingRuns.delete(effectiveRunId);
  }

  startTool(toolCallId: string, toolName: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.appendNonSystem(component);
    return component;
  }

  updateToolArgs(toolCallId: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    existing.setArgs(args);
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (opts?.partial) {
      existing.setPartialResult(text);
      return;
    }
    existing.setResult(text, { isError: opts?.isError });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.repeatableSystemMessage = null;
    this._scrollOffset = 0;
  }

  getContentLines(): string[] {
    const lines: string[] = [];
    const collect = (comp: unknown) => {
      if (comp instanceof Text) {
        const text = (comp as unknown as { text?: string }).text ?? '';
        lines.push(text);
      }
    };
    const walk = (container: { children?: unknown[] }) => {
      if (!container.children) return;
      for (const child of container.children) {
        collect(child);
        if (child instanceof Container) walk(child as unknown as { children?: unknown[] });
      }
    };
    walk(this as unknown as { children?: unknown[] });
    return lines;
  }

  getLineCount(): number {
    let count = 0;
    for (const line of this.getContentLines()) {
      count += line.split('\n').length;
    }
    return count;
  }

  setViewportHeight(height: number): void {
    this._viewportHeight = Math.max(1, height);
  }

  scrollToLine(line: number): void {
    const totalLines = this.getLineCount();
    const maxOffset = Math.max(0, totalLines - this._viewportHeight);
    if (line < 0) {
      this._scrollOffset = Math.max(0, this._scrollOffset + line);
    } else if (line >= totalLines) {
      this._scrollOffset = maxOffset;
    } else {
      this._scrollOffset = Math.min(Math.max(0, line), maxOffset);
    }
  }

  get scrollOffset(): number {
    return this._scrollOffset;
  }
}
