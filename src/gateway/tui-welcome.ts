/**
 * tui-welcome.ts —— 启动欢迎屏 + ASCII Art 加载模块（tui.ts 深拆第四批）。
 *
 * 从 runTui 闭包迁出 loadAsciiArt（纯函数：扫描 ~/.agent/ascii 轮播图片，
 * 命中缓存读缓存，否则调 imageToAscii 生成并写缓存）与 Welcome 渲染块
 * （Hyacinth 标题框 + Persona + 操作提示 + 旧版终端检测 + 历史会话重放）。
 *
 * 行为零变更：ascii 目录轮播去重（跳过上次 _last.txt）、缓存 mtime 判新、
 * 标题/CWD/提示行渲染、detectLegacyTerminal 分支、replayEvents 重放均原样保留。
 * asciiDir 可注入以便测试（默认 ~/.agent/ascii）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';
import { BOX_H, detectLegacyTerminal, replayEvents } from './tui-format.js';

/** 加载欢迎屏的最小依赖面（chatLog 需覆盖 showWelcome 与 replayEvents 用到的方法） */
export interface TuiWelcomeDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem' | 'addUser' | 'startTool' | 'updateToolResult'>;
  /** Persona 目录（启动时展示） */
  personaDir: string;
  /** 启动时重放的历史会话目录（可空，跳过重放） */
  sessionDir?: string;
  /** ASCII 图片目录（可注入以便测试；默认 ~/.agent/ascii） */
  asciiDir?: string;
}

/** 加载并轮播 ASCII art：扫描目录图片，跳过上次展示的，命中缓存读缓存，否则生成并缓存 */
async function loadAsciiArt(asciiDir: string, maxWidth = 54): Promise<{ text: string; width: number } | null> {
  const lastFile = path.join(asciiDir, '_last.txt');
  try {
    if (!fs.existsSync(asciiDir)) {
      fs.mkdirSync(asciiDir, { recursive: true });
      return null;
    }
    const files = fs.readdirSync(asciiDir);
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const imageFiles = files.filter(f =>
      imageExts.includes(path.extname(f).toLowerCase()),
    );
    if (imageFiles.length === 0) return null;
    let prevName = '';
    try { prevName = fs.readFileSync(lastFile, 'utf-8').trim(); } catch { /* first */ }
    const candidates =
      imageFiles.length > 1 ? imageFiles.filter(f => f !== prevName) : imageFiles;
    const pool = candidates.length > 0 ? candidates : imageFiles;
    const picked = pool[Math.floor(Math.random() * pool.length)]!;
    try { fs.writeFileSync(lastFile, picked, 'utf-8'); } catch { /* ignore */ }
    const imgPath = path.join(asciiDir, picked);
    const cachePath = path.join(asciiDir, picked + '.txt');
    try {
      const imgStat = fs.statSync(imgPath);
      const cacheStat = fs.statSync(cachePath);
      if (cacheStat.mtimeMs >= imgStat.mtimeMs) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { text: string; width: number };
      }
    } catch { /* cache miss */ }
    const { imageToAscii } = await import('../orchestrator/loop.js');
    const result = await imageToAscii(imgPath, maxWidth);
    if (result) {
      try { fs.writeFileSync(cachePath, JSON.stringify(result), 'utf-8'); } catch { /* ignore */ }
    }
    return result;
  } catch {
    return null;
  }
}

/** 渲染启动欢迎屏（标题框 + Persona + 操作提示 + 旧版终端警告 + 历史重放） */
export async function showWelcome(deps: TuiWelcomeDeps): Promise<void> {
  const { tui, chatLog, personaDir } = deps;
  const asciiDir = deps.asciiDir ?? path.join(os.homedir(), '.agent', 'ascii');

  const asciiArt = await loadAsciiArt(asciiDir, 54);
  const cwd = process.cwd();
  const cwdDisplay = cwd.length > 50 ? '...' + cwd.slice(-47) : cwd;
  const boxLines: string[] = [];
  boxLines.push(theme.fg('\u256d' + BOX_H.repeat(58) + '\u256e'));
  if (asciiArt) {
    const artWidth = asciiArt.width;
    const pad = Math.max(0, 56 - artWidth);
    for (const line of asciiArt.text.split('\n')) {
      boxLines.push(theme.fg('\u2502 ') + line + ' '.repeat(pad) + theme.fg(' \u2502'));
    }
  }
  // Hyacinth 标题行
  const titleLine = theme.fg(' Hyacinth');
  const titlePad = Math.max(0, 56 - 9); // ' Hyacinth' = 9 chars visible
  boxLines.push(theme.fg('\u2502 ') + titleLine + ' '.repeat(titlePad) + theme.fg(' \u2502'));
  // CWD 行
  const cwdPad = Math.max(0, 56 - [...cwdDisplay].length);
  boxLines.push(theme.fg('\u2502 ') + theme.dim(cwdDisplay) + ' '.repeat(cwdPad) + theme.fg(' \u2502'));
  boxLines.push(theme.fg('\u2570' + BOX_H.repeat(58) + '\u256f'));
  chatLog.addSystem(boxLines.join('\n'));
  chatLog.addSystem('');
  chatLog.addSystem(theme.dim('Persona: ') + theme.accent(personaDir));
  chatLog.addSystem('');

  chatLog.addSystem(
    theme.dim('Type ') +
      theme.success('exit') +
      theme.dim(' to quit. ') +
      theme.success('Ctrl+C') +
      theme.dim(' twice to force. ') +
      theme.success('Ctrl+P') +
      theme.dim(' to toggle provider.'),
  );
  chatLog.addSystem('');
  if (detectLegacyTerminal()) {
    chatLog.addSystem(
      theme.warning('\u26a0 检测到旧版控制台，Unicode/emoji 可能显示成方块。') +
        '\n' +
        theme.dim('  建议安装 Windows Terminal: ') +
        theme.accent('winget install Microsoft.WindowsTerminal'),
    );
    chatLog.addSystem('');
  }
  tui.requestRender();

  // Replay previous session events
  if (deps.sessionDir) {
    replayEvents(chatLog, deps.sessionDir);
  }
}
