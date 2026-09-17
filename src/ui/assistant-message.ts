import { Container, Spacer } from '@earendil-works/pi-tui';
import { markdownTheme, theme } from './theme.js';
import { HyperlinkMarkdown } from './hyperlink-markdown.js';

export class AssistantMessageComponent extends Container {
  private body: HyperlinkMarkdown;

  /**
   * @param colorFn 正文着色函数（缺省为无色 assistant 文本）。
   *   say 交付块传 theme.delivered，使"模型的嘴"在 UI 上与普通输出区分开。
   */
  constructor(text: string, colorFn: (line: string) => string = theme.assistantText) {
    super();
    this.body = new HyperlinkMarkdown(text, 0, 0, markdownTheme, {
      color: colorFn,
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}
