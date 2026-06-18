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
  setCapabilities(tools, skills, agents, workflows) { set({ tools, skills, agents, workflows }); },
  toggleToolExpanded(toolId) { set(s => ({ messages: s.messages.map(m => m.kind === 'tool' && m.id === toolId ? { ...m, expanded: !(m as ToolCallNode).expanded } : m) })); },
  toggleThinkingCollapsed(nodeId) { set(s => ({ messages: s.messages.map(m => m.kind === 'thinking' && m.id === nodeId ? { ...m, collapsed: !(m as ThinkingMsgNode).collapsed } : m) })); },
}));
