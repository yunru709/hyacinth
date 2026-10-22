import { Container, Spacer } from '@earendil-works/pi-tui';
import { markdownTheme } from './theme.js';
import { HyperlinkMarkdown } from './hyperlink-markdown.js';
import { latexToUnicode } from './latex-unicode.js';

type MarkdownOptions = ConstructorParameters<typeof HyperlinkMarkdown>[4];

export class MarkdownMessageComponent extends Container {
  private body: HyperlinkMarkdown;

  constructor(text: string, y: number, options?: MarkdownOptions) {
    super();
    // LaTeX → Unicode 折叠必须在**送进 pi-tui 之前**做：那个组件不认公式语法。
    // 见 ./latex-unicode.ts 顶部的能力边界说明（终端是字符网格，二维排版无解）。
    this.body = new HyperlinkMarkdown(latexToUnicode(text), 0, y, markdownTheme, options);
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(latexToUnicode(text));
  }
}
