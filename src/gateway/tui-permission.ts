/**
 * tui-permission.ts —— 工具权限对话框模块（tui.ts 深拆第二批）。
 *
 * 从 runTui 闭包迁出权限族（showPermissionDialog/resolvePermission/
 * updatePermissionBar + permissionQueue/permissionSelection 状态）。
 * 依赖经工厂参数注入：tui（渲染）、chatLog（提示输出）、permissionBar
 * （底部选择条 Text）、protocolSend（permission.resolve 协议回传）。
 *
 * 行为零变更：队列先进先出、选择序 0=Yes/1=AOR/2=Always/3=No、
 * 全部按键消费语义保留在调用方（本模块只提供 moveSelection/confirm）。
 */

import type { Text, TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';

/** 权限请求条目 */
export interface PermissionRequest {
  id: string;
  toolName: string;
  inputStr: string;
}

export type PermissionResult = 'yes' | 'no' | 'always' | 'aor';

/** 权限模块的最小依赖面（结构化类型，便于测试替换） */
export interface TuiPermissionDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem'>;
  /** 底部权限选择条（root 布局中的 Text，由调用方创建并挂载） */
  permissionBar: Text;
  /** 协议回传：permission.resolve */
  protocolSend: (method: string, params?: unknown) => Promise<unknown>;
}

/** 创建权限对话框控制器（队列与选择状态封装在闭包内） */
export function createTuiPermission(deps: TuiPermissionDeps) {
  const { tui, chatLog, permissionBar, protocolSend } = deps;

  const permissionQueue: PermissionRequest[] = [];
  let permissionSelection = 0; // 0=Yes, 1=AOR, 2=Always, 3=No

  function updatePermissionBar(): void {
    const labels = ['Yes', 'AOR', 'Always', 'No'];
    const shortcuts = ['Y', 'O', 'A', 'N'];
    const parts = labels.map((l, i) => {
      const prefix = i === permissionSelection ? '\u25b6 ' : '  ';
      if (i === permissionSelection) {
        return theme.fg(`[ ${prefix}${l} (${shortcuts[i]}) ]`);
      }
      return theme.dim(`  ${prefix}${l} (${shortcuts[i]})  `);
    });
    permissionBar.setText(
      theme.warning('\u250c Permission Required \u2500 ') +
      parts.join(theme.dim(' \u2502 ')) +
      theme.warning(' \u2500\u2500 Use \u2190\u2192 to select, Enter to confirm')
    );
  }

  function showPermissionDialog(toolName: string, inputStr: string): void {
    permissionSelection = 0;
    chatLog.addSystem(
      theme.warning(`\u250c Permission Required \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510`),
    );
    chatLog.addSystem(
      theme.warning('\u2502 ') + theme.fg(`${toolName}(${inputStr})`) + theme.warning(' \u2502'),
    );
    chatLog.addSystem(
      theme.warning(`\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`),
    );
    // 作用域说明（问题 2-②）：Always/AOR 仅本会话生效；跨会话持久放行走 allow_tool（全局白名单）
    chatLog.addSystem(
      theme.dim('  Always/AOR = this session only \u00b7 use allow_tool to persist globally'),
    );
    updatePermissionBar();
    tui.requestRender();
  }

  function resolvePermission(result: PermissionResult): void {
    const req = permissionQueue.shift();
    if (!req) return;

    permissionBar.setText('');
    chatLog.addSystem(
      result === 'no' ? theme.error('  \u25c6 Denied')
        : result === 'aor' ? theme.warning('  \u25c6 AOR \u2014 all restrictions lifted (this session)')
        : result === 'always' ? theme.success('  \u25c6 Always allowed (this session)')
        : theme.success('  \u25c6 Approved'),
    );
    void protocolSend('permission.resolve', { id: req.id, result });

    if (permissionQueue.length > 0) {
      const next = permissionQueue[0]!;
      showPermissionDialog(next.toolName, next.inputStr);
    }
    tui.requestRender();
  }

  return {
    /** 是否有待处理的权限请求（原 permissionQueue.length > 0 读点） */
    hasPending: (): boolean => permissionQueue.length > 0,
    /** 入队请求；若为队首（此前队列空）立即弹窗 */
    enqueue: (req: PermissionRequest): void => {
      const isFirst = permissionQueue.length === 0;
      permissionQueue.push(req);
      if (isFirst) showPermissionDialog(req.toolName, req.inputStr);
    },
    /** ← 选择左移（调用方消费按键后调用） */
    moveLeft: (): void => {
      permissionSelection = (permissionSelection + 3) % 4;
      updatePermissionBar();
    },
    /** → 选择右移（调用方消费按键后调用） */
    moveRight: (): void => {
      permissionSelection = (permissionSelection + 1) % 4;
      updatePermissionBar();
    },
    /** Enter 确认当前选择 */
    confirm: (): void => {
      const options: PermissionResult[] = ['yes', 'aor', 'always', 'no'];
      resolvePermission(options[permissionSelection]!);
    },
  };
}

export type TuiPermission = ReturnType<typeof createTuiPermission>;
