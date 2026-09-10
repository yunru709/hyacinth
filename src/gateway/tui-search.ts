/**
 * tui-search.ts —— TUI 搜索浮层模块（tui.ts 深拆第一批）。
 *
 * 从 runTui 闭包迁出 Search 函数族（highlightMatch/performSearch/nextSearchMatch/
 * openSearch/closeSearch + 5 个状态变量 + 输入监听）。依赖经工厂参数注入：
 *   - tui：浮层/渲染/输入监听（pi-tui TUI 实例）
 *   - chatLog：行内容读取 + 滚动定位
 *   - theme：着色
 *
 * 行为零变更：状态变量封装进工厂闭包，对外只暴露 isOpen()/open()/close()/
 * getMode()。原 tui.ts 中 Ctrl+F toggle 与 editor.onEscape 分支改调本模块。
 */

import {
  Container,
  Key,
  matchesKey,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';

/** 搜索模块的最小依赖面（结构化类型，便于测试替换） */
export interface TuiSearchDeps {
  tui: Pick<TUI, 'showOverlay' | 'hideOverlay' | 'requestRender' | 'addInputListener'>;
  chatLog: Pick<ChatLog, 'getContentLines' | 'scrollToLine'>;
}

/** 行内容去除 ANSI 转义（搜索匹配用纯文本） */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Highlight occurrences of `query` in `text` (case-insensitive) using accent color */
export function highlightMatch(text: string, query: string, maxLen = 80): string {
  if (!query) return theme.dim(text.slice(0, maxLen));
  const truncated = text.slice(0, maxLen);
  const lower = truncated.toLowerCase();
  const q = query.toLowerCase();
  let result = '';
  let idx = 0;
  while (idx < truncated.length) {
    const found = lower.indexOf(q, idx);
    if (found === -1) {
      result += theme.dim(truncated.slice(idx));
      break;
    }
    if (found > idx) {
      result += theme.dim(truncated.slice(idx, found));
    }
    result += theme.accent(truncated.slice(found, found + q.length));
    idx = found + q.length;
  }
  return result;
}

/** 创建搜索浮层控制器（状态封装在闭包内） */
export function createTuiSearch(deps: TuiSearchDeps) {
  const { tui, chatLog } = deps;

  let searchMode = false;
  let searchQuery = '';
  let searchMatches: number[] = [];
  let searchMatchIndex = 0;
  let searchOverlayContainer: Container | null = null;
  let searchOverlayText: Text | null = null;

  function performSearch(query: string): void {
    searchQuery = query;
    const contentLines = chatLog.getContentLines();
    const cleanLines = contentLines.map(stripAnsi);

    searchMatches = [];
    const lowerQuery = query.toLowerCase();
    for (let i = 0; i < cleanLines.length; i++) {
      if (cleanLines[i]!.toLowerCase().includes(lowerQuery)) {
        searchMatches.push(i);
      }
    }
    searchMatchIndex = 0;

    if (searchOverlayText) {
      if (searchMatches.length > 0) {
        const preview = highlightMatch(cleanLines[searchMatches[0]]!, query);
        searchOverlayText.setText(
          theme.accent('Search: ') +
            theme.fg(query) +
            theme.dim(` [${searchMatchIndex + 1}/${searchMatches.length}]`) +
            '\n' +
            preview,
        );
      } else {
        searchOverlayText.setText(
          theme.accent('Search: ') + theme.fg(query) + theme.dim(' [0/0]'),
        );
      }
    }
    tui.requestRender();
  }

  function nextSearchMatch(): void {
    if (searchMatches.length === 0) return;
    searchMatchIndex = (searchMatchIndex + 1) % searchMatches.length;
    chatLog.scrollToLine(searchMatches[searchMatchIndex]!);
    if (searchOverlayText) {
      const contentLines = chatLog.getContentLines();
      const cleanLines = contentLines.map(stripAnsi);
      const preview = highlightMatch(cleanLines[searchMatches[searchMatchIndex]] ?? '', searchQuery);
      searchOverlayText.setText(
        theme.accent('Search: ') +
          theme.fg(searchQuery) +
          theme.dim(` [${searchMatchIndex + 1}/${searchMatches.length}]`) +
          '\n' +
          preview,
      );
    }
    tui.requestRender();
  }

  function closeSearch(): void {
    searchMode = false;
    searchQuery = '';
    searchMatches = [];
    searchMatchIndex = 0;
    searchOverlayText = null;
    if (searchOverlayContainer) {
      tui.hideOverlay();
      searchOverlayContainer = null;
    }
    tui.requestRender();
  }

  function openSearch(): void {
    searchMode = true;
    searchQuery = '';
    searchMatches = [];
    searchMatchIndex = 0;

    searchOverlayContainer = new Container();
    searchOverlayText = new Text(
      theme.accent('Search: ') + theme.dim('type to search, Enter for next, Esc to close'),
      0,
      0,
    );
    searchOverlayContainer.addChild(searchOverlayText);
    tui.showOverlay(searchOverlayContainer);
    tui.requestRender();

    // Add a temporary input listener for search typing
    tui.addInputListener((data) => {
      if (!searchMode) return undefined;

      if (matchesKey(data, Key.escape)) {
        closeSearch();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        nextSearchMatch();
        return { consume: true };
      }
      if (matchesKey(data, Key.backspace)) {
        if (searchQuery.length > 0) {
          searchQuery = searchQuery.slice(0, -1);
          performSearch(searchQuery);
        }
        return { consume: true };
      }
      // Regular character input
      if (typeof data === 'string' && data.length === 1 && !data.startsWith('\x1b')) {
        searchQuery += data;
        performSearch(searchQuery);
        return { consume: true };
      }
      // Consume all other input while searching
      return { consume: true };
    });
  }

  return {
    /** 搜索浮层是否打开（原 searchMode 读点） */
    getMode: (): boolean => searchMode,
    /** Ctrl+F toggle：已开则关，未开则开 */
    toggle: (): void => {
      if (searchMode) {
        closeSearch();
      } else {
        openSearch();
      }
    },
    /** Esc 关闭（仅在搜索态生效） */
    closeIfOpen: (): void => {
      if (searchMode) {
        closeSearch();
      }
    },
  };
}

export type TuiSearch = ReturnType<typeof createTuiSearch>;
