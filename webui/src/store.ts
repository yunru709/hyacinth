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
  WebUIMode,
  ActivityView,
  InspectorView,
  PanelView,
  WebUIConfig,
  ModelStatus,
} from './types';

let nextId = 1;
function uid(): string { return `msg_${nextId++}_${Date.now().toString(36)}`; }

const helpText = [
  '── Slash Commands ──',
  '/clear        Clear chat log',
  '/help         Show this help',
  '/model <name> Switch model',
  '/precise on|off  Toggle precise mode',
  '/kb on|off    Toggle knowledge base',
  '/rollback N   Roll back N turns',
  '── Visual Actions ──',
  'Use the ChatLog buttons to clear the log, collapse/expand all tool cards, or show this help.',
  '── Or just type a message to chat with the agent ──',
].join('\n');

interface WebUIState {
  // ── Theme ──
  theme: 'dark' | 'light';
  toggleTheme: () => void;

  // ── Activity / Inspector ──
  activeActivity: ActivityView;
  setActiveActivity: (view: ActivityView) => void;
  inspectorOpen: boolean;
  inspectorView: InspectorView;
  activePanel: PanelView | null;
  openInspector: (view: InspectorView) => void;
  openPanel: (panel: PanelView) => void;
  closeInspector: () => void;

  // ── Sidebar ──
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // ── Connection ──
  connected: boolean;
  ready: boolean;
  sessionId: string | null;
  mode: WebUIMode;
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

  // ── Queue ──
  queuedMessages: string[];
  addQueuedMessage: (content: string) => void;
  removeQueuedMessage: (index: number) => void;
  clearQueuedMessages: () => void;

  // ── Command Palette ──
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  // ── Sessions ──
  sessions: SessionInfo[];
  activeSessionId: string | null;

  // ── Registry ──
  tools: ToolInfo[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  workflows: WorkflowInfo[];

  // ── Model Center ──
  modelStatus: ModelStatus | null;
  setModelStatus: (status: ModelStatus) => void;

  // ── Config Panel ──
  webuiConfig: WebUIConfig | null;
  configLoading: boolean;
  configSaving: boolean;
  toast: { message: string; type: 'success' | 'error' } | null;
  fetchConfig: () => Promise<void>;
  patchConfig: (updates: Record<string, unknown>) => Promise<boolean>;

  // ── Actions ──
  addUserMsg: (content: string) => void;
  appendText: (content: string) => void;
  appendThinking: (content: string) => void;
  addToolCall: (id: string, name: string, inputSummary: string) => void;
  completeToolCall: (id: string, content: string, isError: boolean) => void;
  showDiff: (id: string, filePath: string, diffLines: Array<{ kind: string; text: string }>) => void;
  addSystemMsg: (content: string, level: 'info' | 'warn' | 'error') => void;
  clearChatLog: () => void;
  showHelp: () => void;
  startTurn: () => void;
  flushCurrent: () => void;
  updateTurnInfo: (info: { turnCount: number; maxTurns: number; tokensUsed: number; maxTokens: number; cacheHitRate: number | null; compressCount: number }) => void;
  setPermission: (req: PermissionRequestMsg | null) => void;
  setConnected: (sessionId: string, mode: WebUIMode, config: WebUIState['config']) => void;
  setMode: (mode: WebUIMode, sessionId?: string) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  loadHistory: (events: ConversationEvent[]) => void;
  setCapabilities: (tools: ToolInfo[], skills: SkillInfo[], agents: AgentInfo[], workflows: WorkflowInfo[]) => void;
  toggleToolExpanded: (toolId: string) => void;
  setAllToolsExpanded: (expanded: boolean) => void;
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

  activeActivity: 'sessions',
  setActiveActivity: (view) => set({ activeActivity: view, sidebarOpen: true }),
  inspectorOpen: false,
  inspectorView: 'status',
  activePanel: null,
  openInspector: (view) => set({ inspectorOpen: true, inspectorView: view, activePanel: null }),
  openPanel: (panel) => set({ inspectorOpen: true, activePanel: panel }),
  closeInspector: () => set({ inspectorOpen: false, activePanel: null }),

  sidebarOpen: true,
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),

  connected: false,
  ready: false,
  sessionId: null,
  mode: 'normal',
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
  queuedMessages: [],
  addQueuedMessage: (content) => set(s => ({ queuedMessages: [...s.queuedMessages, content] })),
  removeQueuedMessage: (index) => set(s => ({ queuedMessages: s.queuedMessages.filter((_, i) => i !== index) })),
  clearQueuedMessages: () => set({ queuedMessages: [] }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  sessions: [],
  activeSessionId: null,
  tools: [], skills: [], agents: [], workflows: [],
  modelStatus: null,
  setModelStatus: (status) => set({ modelStatus: status }),

  // ── Config Panel ──
  webuiConfig: null,
  configLoading: false,
  configSaving: false,
  toast: null,
  fetchConfig: async () => {
    set({ configLoading: true });
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WebUIConfig;
      set({ webuiConfig: data, configLoading: false });
    } catch (err) {
      set({ configLoading: false, toast: { message: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`, type: 'error' } });
    }
  },
  patchConfig: async (updates) => {
    set({ configSaving: true });
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // 刷新配置
      await get().fetchConfig();
      set({ configSaving: false, toast: { message: 'Settings saved successfully', type: 'success' } });
      return true;
    } catch (err) {
      set({ configSaving: false, toast: { message: `Failed to save: ${err instanceof Error ? err.message : String(err)}`, type: 'error' } });
      return false;
    }
  },

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
  clearChatLog() { set({ messages: [], currentText: '', currentThinking: '', pendingThinking: '' }); },
  showHelp() { get().addSystemMsg(helpText, 'info'); },
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
  setConnected(sessionId, mode, config) { set({ connected: true, sessionId, activeSessionId: sessionId, mode, config }); },
  setMode(mode, sessionId) { set({ mode, ...(sessionId ? { sessionId, activeSessionId: sessionId } : {}) }); },
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
  setAllToolsExpanded(expanded) { set(s => ({ messages: s.messages.map(m => m.kind === 'tool' ? { ...m, expanded } : m) })); },
  toggleThinkingCollapsed(nodeId) { set(s => ({ messages: s.messages.map(m => m.kind === 'thinking' && m.id === nodeId ? { ...m, collapsed: !(m as ThinkingMsgNode).collapsed } : m) })); },
}));
