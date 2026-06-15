import { Editor, Key, matchesKey } from '@earendil-works/pi-tui';

export type CustomEditorCallbacks = {
  onSubmit?: (text: string) => void;
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlL?: () => void;
  onCtrlP?: () => void;
  onAltEnter?: () => void;
};

/**
 * CustomEditor extends pi-tui's Editor with keybinding callbacks.
 *
 * Usage in tui.ts:
 *   const editor = new CustomEditor(tui, editorTheme);
 *   editor.onSubmit = submitHandler;
 *   editor.onEscape = () => { ... };
 *   editor.onCtrlC = () => { ... };
 *
 * The base Editor already handles multi-line editing, undo, and autocomplete
 * dropdown rendering.  This subclass only adds keybinding dispatch.
 */
export class CustomEditor extends Editor {
  declare onSubmit?: (text: string) => void;
  declare onEscape?: () => void;
  declare onCtrlC?: () => void;
  declare onCtrlD?: () => void;
  declare onCtrlL?: () => void;
  declare onCtrlP?: () => void;
  declare onAltEnter?: () => void;

  override handleInput(data: string): void {
    // Alt+Enter: trigger alternative submit (e.g. multi-line mode toggle)
    if (matchesKey(data, Key.alt('enter')) && this.onAltEnter) {
      this.onAltEnter();
      return;
    }

    // Ctrl+L: open model selector or clear screen
    if (matchesKey(data, Key.ctrl('l')) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }

    // Ctrl+P: open session/agent selector
    if (matchesKey(data, Key.ctrl('p')) && this.onCtrlP) {
      this.onCtrlP();
      return;
    }

    // Escape: abort current operation, only when autocomplete is not visible
    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }

    // Ctrl+C: clear input or exit
    if (matchesKey(data, Key.ctrl('c')) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }

    // Ctrl+D: exit on empty line
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }

    // Enter: submit current text
    if (matchesKey(data, Key.enter) && this.onSubmit) {
      // When autocomplete is showing (e.g. slash commands), let base Editor
      // handle completion first; it will applyCompletion then fall through to
      // submit via its own onSubmit mechanism.
      if (this.isShowingAutocomplete()) {
        super.handleInput(data);
        return;
      }
      // Use getExpandedText() to expand paste markers like "[paste #2 +32 lines]"
      // into the actual pasted content. getText() returns raw text with markers.
      const text = this.getExpandedText().trim();
      if (text.length > 0) {
        this.onSubmit(text);
        this.setText('');
      }
      return;
    }

    // Delegate all other input to the base Editor (multi-line editing, undo,
    // autocomplete navigation, Ctrl+Left/Right word jumps, etc.)
    super.handleInput(data);
  }
}