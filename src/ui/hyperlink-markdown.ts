import type { Component, DefaultTextStyle, MarkdownTheme } from '@earendil-works/pi-tui';
import { Markdown } from '@earendil-works/pi-tui';
import { addOsc8Hyperlinks, extractUrls } from './osc8-hyperlinks.js';

export class HyperlinkMarkdown implements Component {
  private inner: Markdown;
  private urls: string[];

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    options?: DefaultTextStyle,
  ) {
    this.inner = new Markdown(text, paddingX, paddingY, theme, options);
    this.urls = extractUrls(text);
  }

  render(width: number): string[] {
    return addOsc8Hyperlinks(this.inner.render(width), this.urls);
  }

  setText(text: string): void {
    this.inner.setText(text);
    this.urls = extractUrls(text);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
