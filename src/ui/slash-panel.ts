/**
 * SlashSubPanel — 斜杠命令二级菜单浮层面板
 *
 * 当用户输入有 children 的斜杠命令（如 /model）时弹出，
 * 使用 pi-tui SelectList 提供上下选择、回车确认、Esc 退出。
 */

import { Box, type Component, matchesKey, type SelectItem, SelectList, type SelectListTheme, Text } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import type { SlashCommandDef } from './command-registry.js';

export interface SubPanelResult {
  path: string;
  command: SlashCommandDef;
}

export interface SlashSubPanelTheme {
  title: (text: string) => string;
  hint: (text: string) => string;
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export const DEFAULT_PANEL_THEME: SlashSubPanelTheme = {
  title: (t) => `\x1b[1;36m${t}\x1b[0m`,
  hint: (t) => `\x1b[2m${t}\x1b[0m`,
  selectedPrefix: (t) => `\x1b[1;33m>\x1b[0m `,
  selectedText: (t) => `\x1b[1;37m${t}\x1b[0m`,
  description: (t) => `\x1b[2m${t}\x1b[0m`,
  scrollInfo: (t) => `\x1b[2m${t}\x1b[0m`,
  noMatch: (t) => `\x1b[2m${t}\x1b[0m`,
};

export class SlashSubPanel {
  private container: Box;
  private selectList: SelectList;
  private promptText: Text;
  private resolved: ((result: SubPanelResult | null) => void) | null = null;
  private tui: TUI | null = null;
  private keyListenerId: string | null = null;
  private items: SelectItem[];
  private readonly parentCommand: SlashCommandDef;
  private children: SlashCommandDef[];
  private readonly parentName: string;
  private readonly theme: SlashSubPanelTheme;

  // ── Multi-level navigation ──────────────────────────────
  private parentPanel: SlashSubPanel | null = null;
  private childPanel: SlashSubPanel | null = null;
  private active: boolean = false;
  private readonly fullPath: string;

  constructor(
    parentCommand: SlashCommandDef,
    theme: SlashSubPanelTheme = DEFAULT_PANEL_THEME,
    parentPanel: SlashSubPanel | null = null,
    pathPrefix: string = '',
  ) {
    this.parentCommand = parentCommand;
    this.children = parentCommand.children ?? [];
    this.parentName = parentCommand.name;
    this.theme = theme;
    this.parentPanel = parentPanel;
    this.fullPath = pathPrefix ? `${pathPrefix}/${parentCommand.name}` : parentCommand.name;

    this.items = this.buildItems(this.children);

    const selectTheme: SelectListTheme = {
      selectedPrefix: theme.selectedPrefix,
      selectedText: theme.selectedText,
      description: theme.description,
      scrollInfo: theme.scrollInfo,
      noMatch: theme.noMatch,
    };

    const maxVisible = Math.min(this.items.length, 10);
    this.selectList = new SelectList(this.items, maxVisible, selectTheme);

    this.promptText = new Text(
      theme.title(` ${this.fullPath}`) +
        theme.hint(' — (\u2191\u2193 navigate, Enter/Space confirm, Esc back)'),
      0,
      0,
    );

    this.container = new Box(1, 1);
    this.container.addChild(this.promptText);
    this.container.addChild(this.selectList);
  }

  getContainer(): Component {
    return this.container;
  }

  getSelectList(): SelectList {
    return this.selectList;
  }

  private buildItems(cmds: SlashCommandDef[]): SelectItem[] {
    return cmds.map((c) => ({
      value: `${this.fullPath}/${c.name}`,
      label: c.args ? `/${this.fullPath} ${c.name} ${c.args}` : `/${this.fullPath} ${c.name}`,
      description: c.description + (c.args ? ` ${c.args}` : ''),
    }));
  }

  async show(tui: TUI, onResolve: (result: SubPanelResult | null) => void): Promise<void> {
    // 动态子命令：面板打开时从 childrenProvider 生成
    if (this.parentCommand.childrenProvider) {
      const dynamic = await this.parentCommand.childrenProvider();
      if (dynamic.length > 0) {
        this.children = dynamic;
        this.items = this.buildItems(dynamic);
        // 重建 SelectList 以反映新 items
        const maxVisible = Math.min(this.items.length, 10);
        const selectTheme = {
          selectedPrefix: this.theme.selectedPrefix,
          selectedText: this.theme.selectedText,
          description: this.theme.description,
          scrollInfo: this.theme.scrollInfo,
          noMatch: this.theme.noMatch,
        };
        const oldList = this.selectList;
        this.selectList = new SelectList(this.items, maxVisible, selectTheme);
        this.container.removeChild(oldList);
        this.container.addChild(this.selectList);
      }
    }

    this.tui = tui;
    this.resolved = onResolve;
    this.active = true;
    this.keyListenerId = `slashpanel_${Date.now()}`;

    tui.showOverlay(this.container);
    tui.requestRender();

    tui.addInputListener((data) => {
      if (!this.active || !this.resolved) return undefined;

      if (matchesKey(data, 'escape')) {
        if (this.parentPanel) {
          // 3. Esc with parent: close self, restore parent panel
          this.close();
          this.parentPanel.restoreFromChild();
        } else {
          // 3. Esc without parent (root): dismiss with null
          this.dismiss(null);
        }
        return { consume: true };
      }

      if (matchesKey(data, 'up')) {
        const item = this.selectList.getSelectedItem();
        const idx = item ? this.items.findIndex((i) => i.value === item.value) : 0;
        const newIdx = Math.max(0, idx - 1);
        this.selectList.setSelectedIndex(newIdx);
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, 'down')) {
        const item = this.selectList.getSelectedItem();
        const idx = item ? this.items.findIndex((i) => i.value === item.value) : -1;
        const newIdx = Math.min(this.items.length - 1, idx + 1);
        this.selectList.setSelectedIndex(newIdx);
        tui.requestRender();
        return { consume: true };
      }
      // 4. Space/Return/Enter activation
      if (matchesKey(data, 'return') || matchesKey(data, 'enter') || matchesKey(data, 'space')) {
        const selected = this.selectList.getSelectedItem();
        if (selected) {
          const parts = selected.value.split('/');
          const childCmd = this.children.find((c) => c.name === parts[parts.length - 1]);
          if (childCmd) {
            if (childCmd.children && childCmd.children.length > 0) {
              // 1. Selected sub-command has children: open child panel
              this.openChild(childCmd);
            } else {
              // Leaf command: resolve
              this.dismiss({ path: selected.value, command: childCmd });
            }
          }
        }
        return { consume: true };
      }

      return { consume: true };
    });
  }

  // ── Multi-level helpers ──────────────────────────────────

  /** 1. Open a child panel for a sub-command that has its own children */
  private openChild(childCmd: SlashCommandDef): void {
    this.active = false;
    if (this.tui) {
      this.tui.hideOverlay();
    }
    this.childPanel = new SlashSubPanel(childCmd, this.theme, this, this.fullPath);
    this.childPanel.show(this.tui!, (result) => {
      this.childPanel = null;
      if (result) {
        // Child resolved with a final result → propagate upward
        this.dismiss(result);
      }
      // If result is null, child was discarded via Esc → restoreFromChild already called
    });
  }

  /** Restore this panel after a child panel was dismissed via Esc */
  private restoreFromChild(): void {
    this.childPanel = null;
    this.active = true;
    if (this.tui) {
      this.tui.showOverlay(this.container);
      this.tui.requestRender();
    }
  }

  /** Close this panel without resolving (used when Esc navigates up to parent) */
  private close(): void {
    this.active = false;
    this.resolved = null;
    if (this.tui) {
      this.tui.hideOverlay();
    }
  }

  /** Terminal: resolve and clean up */
  private dismiss(result: SubPanelResult | null): void {
    this.active = false;
    if (this.resolved) {
      const cb = this.resolved;
      this.resolved = null;
      cb(result);
    }
    if (this.tui) {
      this.tui.hideOverlay();
      this.tui.requestRender();
    }
  }
}