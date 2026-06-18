import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import type { ServerMessage, ClientMessage, TurnInfoMsg, PermissionRequestMsg, WebUIMode } from '../types';

/** 本地处理的斜杠命令 */
const LOCAL_COMMANDS: Record<string, (args: string) => void> = {};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const store = useStore();
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // WebSocket 已连接，隐藏断线遮罩（但还没 ready，不能发消息）
      useStore.setState({ connected: true });
      // 加载能力数据
      Promise.all([
        fetch('/api/sessions').then((r) => r.json()).catch(() => []),
        fetch('/api/tools').then((r) => r.json()).catch(() => []),
        fetch('/api/skills').then((r) => r.json()).catch(() => []),
        fetch('/api/agents').then((r) => r.json()).catch(() => []),
        fetch('/api/workflows').then((r) => r.json()).catch(() => []),
      ]).then(([sessions, tools, skills, agents, workflows]) => {
        store.setSessions(sessions);
        store.setCapabilities(tools, skills, agents, workflows);
      }).catch(() => {});
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);
        handleServerMessage(msg);
      } catch {
        // 忽略无效消息
      }
    };

    ws.onclose = () => {
      useStore.setState({ connected: false, ready: false });
      // 自动重连（3 秒后）
      reconnectTimer.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = () => {
      // 错误由 onclose 处理
    };
  }, []);

  const handleServerMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case 'connected':
        store.setConnected(msg.sessionId, msg.mode, msg.config);
        // 收到 connected 表示后端初始化完成，可以发消息了
        useStore.setState({ ready: true });
        store.addSystemMsg('Connected — ready.', 'info');
        break;

      case 'text':
        store.appendText(msg.content);
        break;

      case 'thinking':
        store.appendThinking(msg.content);
        break;

      case 'tool_use':
        store.addToolCall(msg.id, msg.name, msg.inputSummary);
        break;

      case 'tool_result':
        store.completeToolCall(msg.id, msg.content, msg.isError);
        break;

      case 'diff':
        store.showDiff(msg.id, msg.filePath, msg.diffLines);
        break;

      case 'status':
        if (msg.mode) store.setMode(msg.mode, msg.sessionId);
        store.addSystemMsg(msg.message, msg.level);
        break;

      case 'turn_start':
        store.startTurn();
        break;

      case 'flush':
        store.flushCurrent();
        // 每回合结束后刷新 session 列表（Agent 可能增删了 session）
        fetch('/api/sessions').then(r => r.json()).then(list => store.setSessions(list)).catch(() => {});
        break;

      case 'interrupt':
        store.flushCurrent();
        break;

      case 'turn_info': {
        const ti = msg as TurnInfoMsg;
        store.updateTurnInfo({
          turnCount: ti.turnCount,
          maxTurns: ti.maxTurns,
          tokensUsed: ti.tokensUsed,
          maxTokens: ti.maxTokens,
          cacheHitRate: ti.cacheHitRate,
          compressCount: ti.compressCount,
        });
        break;
      }

      case 'permission':
        store.setPermission(msg as PermissionRequestMsg);
        break;

      case 'error':
        store.addSystemMsg(msg.message, 'error');
        break;

      case 'session_switched':
        useStore.setState({ sessionId: msg.sessionId, activeSessionId: msg.sessionId, mode: msg.mode, ready: true });
        store.addSystemMsg(`Switched to ${msg.sessionId.slice(0, 12)}...`, 'info');
        fetch('/api/sessions').then(r => r.json()).then(list => store.setSessions(list)).catch(() => {});
        break;
    }
  };

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendChat = useCallback((content: string) => {
    if (!content.trim()) return;

    // 本地处理斜杠命令
    if (content.startsWith('/')) {
      const space = content.indexOf(' ');
      const cmd = space > 0 ? content.slice(0, space) : content;
      const args = space > 0 ? content.slice(space + 1) : '';

      // /clear — 清屏
      if (cmd === '/clear') {
        store.clearChatLog();
        return;
      }
      // /help — 帮助
      if (cmd === '/help') {
        store.showHelp();
        return;
      }
      // /precise on|off
      if (cmd === '/precise') {
        if (args === 'on' || args === 'off') {
          send({ type: 'set_mode', mode: args === 'on' ? 'precise' : 'normal' });
          useStore.setState({ ready: false });
          store.addSystemMsg(`Precise mode: ${args}`, 'info');
        } else {
          store.addSystemMsg('Usage: /precise on|off', 'warn');
        }
        return;
      }
      // Other commands: forward to agent
    }

    store.addUserMsg(content);
    send({ type: 'chat', content });
  }, [send]);

  const sendStop = useCallback(() => {
    send({ type: 'stop' });
  }, [send]);

  const respondPermission = useCallback((result: 'yes' | 'no' | 'always') => {
    send({ type: 'permission', result });
    store.setPermission(null);
  }, [send]);

  const sendRollback = useCallback((toTurnId: number) => {
    send({ type: 'rollback', toTurnId });
  }, [send]);

  const sendMode = useCallback((mode: WebUIMode) => {
    send({ type: 'set_mode', mode });
  }, [send]);

  const switchSession = useCallback((sessionId: string) => {
    send({ type: 'switch_session', sessionId });
  }, [send]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    sendChat,
    sendStop,
    respondPermission,
    sendRollback,
    sendMode,
    switchSession,
    connected: store.connected,
    ready: store.ready,
  };
}
