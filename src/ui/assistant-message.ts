import { Container, Spacer } from '@earendil-works/pi-tui';
import { markdownTheme, theme } from './theme.js';
import { HyperlinkMarkdown } from './hyperlink-markdown.js';

export class AssistantMessageComponent extends Container {
  private body: HyperlinkMarkdown;

  constructor(text: string) {
    super();
    this.body = new HyperlinkMarkdown(text, 0, 0, markdownTheme, {
      color: (line) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}
