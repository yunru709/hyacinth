/**
 * tui-compress-cmds.ts —— compress/* 压缩器控制命令模块（tui.ts 深拆第七批）。
 *
 * threshold / emergency / depth 三子命令完全同构，收敛为表驱动一次消三份
 * 样板（独立审查报告 P3 建议）。零状态写回：依赖仅 setConfig + chatLog +
 * tui + updateTokenEstimate。
 *
 * 行为零变更：参数校验（0.0-1.0）、config key、提示文案、token 估算刷新
 * 原样保留。
 */

import type { TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';

/** compress/* 命令的最小依赖面 */
export interface TuiCompressCmdDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  setConfig: (path: string, value: unknown) => Promise<void>;
  /** runTui 内部函数：token 估算刷新 */
  updateTokenEstimate: () => void;
}

/** 子命令定义表（path 前缀匹配 + config key + 展示文案） */
interface CompressCmdDef {
  path: string;
  key: string;
  label: string;
  usage: string;
}

const COMPRESS_CMDS: CompressCmdDef[] = [
  { path: 'compress/threshold', key: 'context.compressThreshold', label: 'Compress threshold', usage: '/compress threshold <0.0-1.0>' },
  { path: 'compress/emergency', key: 'context.emergencyThreshold', label: 'Emergency threshold', usage: '/compress emergency <0.0-1.0>' },
  { path: 'compress/depth', key: 'context.compressDepth', label: 'Compress depth', usage: '/compress depth <0.0-1.0>' },
];

/** 创建 compress/* 命令处理器（表驱动） */
export function createCompressCmds(deps: TuiCompressCmdDeps) {
  const { tui, chatLog, setConfig, updateTokenEstimate } = deps;

  /** 执行一个 compress 子命令（cmdPath 形如 'compress/threshold'） */
  async function handle(cmdPath: string, restArgs: string): Promise<void> {
    const def = COMPRESS_CMDS.find(
      (c) => cmdPath === c.path || cmdPath.startsWith(c.path + ' '),
    );
    if (!def) return;

    const val = parseFloat((restArgs || '').trim());
    if (isNaN(val) || val < 0 || val > 1) {
      chatLog.addSystem(theme.warning(`Usage: ${def.usage}`));
      tui.requestRender();
      return;
    }
    await setConfig(def.key, val);
    chatLog.addSystem(theme.success(`${def.label}: `) + theme.fg(String(val)));
    tui.requestRender();
    updateTokenEstimate();
  }

  return { handle };
}

export type TuiCompressCmds = ReturnType<typeof createCompressCmds>;
