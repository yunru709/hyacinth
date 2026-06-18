import { create } from 'zustand';
import type {
  ServerMessage,
  MessageNode,
  UserMsgNode,
  TextMsgNode,
  ThinkingMsgNode,
  ToolCallNode,
  SystemMsgNode,
  SessionInfo,
  ToolInfo,
  SkillInfo,
  AgentInfo,
  WorkflowInfo,
  PermissionRequestMsg,
  ConversationEvent,
} from './types';

let nextId = 1;
function uid(): string { return `msg_${nextId++}_${Date.now().toString(36)}`; }

interface WebUIState {
  // ── Theme ──
  theme: 'dark' | 'light';
  toggleTheme: () => void;

  // ── Sidebar ──
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // ── Connection ──
  connected: boolean;
  ready: boolean;
  sessionId: string | null;
  config: { cwd: string; provider: string; model: string; maxTurns: number; maxContext: number } | null;

  // ── Messages ──
  messages: MessageNode[];
  currentText: string;
  currentThinking: string;
  pendingThinking: string;

  // ── Tools ──
  activeToolIds: Map<string, string>;

  // ── Turn ──
  isProcessing: boolean;
  turnCount: number; maxTurns: number;
  tokensUsed: number; maxTokens: number;
  cacheHitRate: number | null;
  compressCount: number;

  // ── Permission ──
  permissionRequest: PermissionRequestMsg | null;

  // ── Sessions ──
  sessions: SessionInfo[];
  activeSessionId: string | null;

  // ── Registry ──
  tools: ToolInfo[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  workflows: WorkflowInfo[];

  // ── Actions ──
  addUserMsg: (content: string) => void;
  appendText: (content: string) => void;
  appendThinking: (content: string) => void;
  addToolCall: (id: string, name: string, inputSummary: string) => void;
  completeToolCall: (id: string, content: string, isError: boolean) => void;
  showDiff: (id: string, filePath: string, diffLines: Array<{ kind: string; text: string }>) => void;
  addSystemMsg: (content: string, level: 'info' | 'warn' | 'error') => void;
  startTurn: () => void;
  flushCurrent: () => void;
  updateTurnInfo: (info: { turnCount: number; maxTurns: number; tokensUsed: number; maxTokens: number; cacheHitRate: number | null; compressCount: number }) => void;
  setPermission: (req: PermissionRequestMsg | null) => void;
  setConnected: (sessionId: string, config: WebUIState['config']) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  loadHistory: (events: ConversationEvent[]) => void;
  setCapabilities: (tools: ToolInfo[], skills: SkillInfo[], agents: AgentInfo[], workflows: WorkflowInfo[]) => void;
  toggleToolExpanded: (toolId: string) => void;
  toggleThinkingCollapsed: (nodeId: string) => void;
}

// Theme persistence
const savedTheme = (typeof localStorage !== 'undefined' && localStorage.getItem('deepthink-theme')) || 'dark';
if (typeof document !== 'undefined') { document.documentElement.className = savedTheme; }

export const useStore = create<WebUIState>((set, get) => ({
  theme: savedTheme as 'dark' | 'light',
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    if (typeof document !== 'undefined') document.documentElement.className = next;
    if (typeof localStorage !== 'undefined') localStorage.setItem('deepthink-theme', next);
    set({ theme: next });
  },

  sidebarOpen: true,
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),

  connected: false,
  ready: false,
  sessionId: null,
  config: null,
  messages: [],
  currentText: '',
  currentThinking: '',
  pendingThinking: '',
  activeToolIds: new Map(),
  isProcessing: false,
  turnCount: 0, maxTurns: 20,
  tokensUsed: 0, maxTokens: 200000,
  cacheHitRate: null, compressCount: 0,
  permissionRequest: null,
  sessions: [],
  activeSessionId: null,
  tools: [], skills: [], agents: [], workflows: [],

  addUserMsg(content) {
    const turnId = get().turnCount + 1; // 新消息属于下一回合
    set(s => ({ messages: [...s.messages, { kind: 'user', content, id: uid(), turnId } as UserMsgNode] }));
  },
  appendText(content) {
    const { messages, pendingThinking } = get();
    const msgs = [...messages];
    if (pendingThinking.trim()) {
      msgs.push({ kind: 'thinking', content: pendingThinking.trim(), id: uid(), collapsed: true } as ThinkingMsgNode);
    }
    set(s => ({ messages: msgs, pendingThinking: '', currentText: s.currentText + content }));
  },
  appendThinking(content) { set(s => ({ pendingThinking: s.pendingThinking + content })); },
  addToolCall(id, name, inputSummary) {
    const { pendingThinking, currentText, messages, activeToolIds } = get();
    const msgs = [...messages];
    if (pendingThinking.trim()) msgs.push({ kind: 'thinking', content: pendingThinking.trim(), id: uid(), collapsed: true } as ThinkingMsgNode);
    if (currentText.trim()) msgs.push({ kind: 'text', content: currentText.trim(), id: uid() } as TextMsgNode);
    const nodeId = uid();
    msgs.push({ kind: 'tool', id: nodeId, name, inputSummary, expanded: true } as ToolCallNode);
    const map = new Map(activeToolIds); map.set(id, nodeId);
    set({ messages: msgs, currentText: '', pendingThinking: '', activeToolIds: map });
  },
  completeToolCall(id, content, isError) {
    const displayId = get().activeToolIds.get(id);
    if (!displayId) return;
    set(s => ({ messages: s.messages.map(m => m.kind === 'tool' && m.id === displayId ? { ...m, result: content, isError } : m) }));
  },
  showDiff(id, filePath, diffLines) {
    const displayId = get().activeToolIds.get(id);
    if (!displayId) return;
    set(s => ({ messages: s.messages.map(m => m.kind === 'tool' && m.id === displayId ? { ...m, diff: { filePath, diffLines } } : m) }));
  },
  addSystemMsg(content, level) { set(s => ({ messages: [...s.messages, { kind: 'system', content, level, id: uid() } as SystemMsgNode] })); },
  startTurn() {
    const { currentText } = get();
    set(s => ({ isProcessing: true, currentText: '', currentThinking: '', pendingThinking: '',
      messages: currentText.trim() ? [...s.messages, { kind: 'text', content: currentText.trim(), id: uid() } as TextMsgNode] : s.messages }));
  },
  flushCurrent() {
    const { currentText, pendingThinking, messages } = get();
    const msgs = [...messages];
    if (pendingThinking.trim()) msgs.push({ kind: 'thinking', content: pendingThinking.trim(), id: uid(), collapsed: true } as ThinkingMsgNode);
    if (currentText.trim()) msgs.push({ kind: 'text', content: currentText.trim(), id: uid() } as TextMsgNode);
    set({ messages: msgs, currentText: '', pendingThinking: '', isProcessing: false });
  },
  updateTurnInfo(info) { set(info); },
  setPermission(req) { set({ permissionRequest: req }); },
  setConnected(sessionId, config) { set({ connected: true, sessionId, config }); },
  setSessions(sessions) { set({ sessions }); },
  loadHistory(events) {
    const messages: MessageNode[] = [];
    // 用于关联 tool_call ↔ tool_result
    const pendingTools = new Map<string, ToolCallNode>();

    for (const ev of events) {
      switch (ev.type) {
        case 'user_input':
          // 如果前面有没匹配到的 tool calls，先 flush
          pendingTools.clear();
          messages.push({
            kind: 'user',
            content: ev.content ?? '',
            id: uid(),
            turnId: 0,
          } as UserMsgNode);
          break;

        case 'thinking':
          messages.push({
            kind: 'thinking',
            content: ev.content ?? '',
            id: uid(),
            collapsed: true, // 历史记录默认折叠
          } as ThinkingMsgNode);
          break;

        case 'text':
          // 合并连续的 text 消息
          if (ev.content) {
            const last = messages[messages.length - 1];
            if (last?.kind === 'text') {
              last.content += '\n' + ev.content;
            } else {
              messages.push({
                kind: 'text',
                content: ev.content,
                id: uid(),
              } as TextMsgNode);
            }
          }
          break;

        case 'tool_call': {
          const node: ToolCallNode = {
            kind: 'tool',
            id: uid(),
            name: ev.name ?? 'unknown',
            inputSummary: ev.input ? JSON.stringify(ev.input).slice(0, 100) : '',
            expanded: false, // 历史记录默认折叠
          };
          messages.push(node);
          if (ev.id) pendingTools.set(ev.id, node);
          break;
        }

        case 'tool_result':
          if (ev.tool_use_id && pendingTools.has(ev.tool_use_id)) {
            const node = pendingTools.get(ev.tool_use_id)!;
            node.result = ev.content ?? '';
            node.isError = ev.content?.startsWith('Error:') ?? false;
            pendingTools.delete(ev.tool_use_id);
          }
          break;

        case 'error':
          messages.push({
            kind: 'system',
            content: ev.message ?? ev.content ?? 'Error',
            level: 'error',
            id: uid(),
          } as SystemMsgNode);
          break;

        // stop / usage — 不显示
      }
    }

    set({ messages });
  },
  setCapabilities(tools, skills, agents, workflows) { set({ tools, skills, agents, workflows }); },
  toggleToolExpanded(toolId) { set(s => ({ messages: s.messages.map(m => m.kind === 'tool' && m.id === toolId ? { ...m, expanded: !(m as ToolCallNode).expanded } : m) })); },
  toggleThinkingCollapsed(nodeId) { set(s => ({ messages: s.messages.map(m => m.kind === 'thinking' && m.id === nodeId ? { ...m, collapsed: !(m as ThinkingMsgNode).collapsed } : m) })); },
}));
