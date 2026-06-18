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
function uid(): string {
  return `msg_${nextId++}_${Date.now().toString(36)}`;
}

interface WebUIState {
  // ── 连接 ──
  connected: boolean;
  ready: boolean;  // WebSocket 连上 + AgentLoop 初始化完成
  sessionId: string | null;
  config: {
    cwd: string;
    provider: string;
    model: string;
    maxTurns: number;
    maxContext: number;
  } | null;

  // ── 消息流 ──
  messages: MessageNode[];
  currentText: string;
  currentThinking: string;
  pendingThinking: string;

  // ── 工具状态 ──
  activeToolIds: Map<string, string>; // toolId → display id

  // ── 回合状态 ──
  isProcessing: boolean;
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxTokens: number;
  cacheHitRate: number | null;
  compressCount: number;

  // ── 权限 ──
  permissionRequest: PermissionRequestMsg | null;

  // ── Session 列表 ──
  sessions: SessionInfo[];

  // ── 能力注册表 ──
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
  updateTurnInfo: (info: {
    turnCount: number;
    maxTurns: number;
    tokensUsed: number;
    maxTokens: number;
    cacheHitRate: number | null;
    compressCount: number;
  }) => void;
  setPermission: (req: PermissionRequestMsg | null) => void;
  setConnected: (sessionId: string, config: WebUIState['config']) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  setCapabilities: (tools: ToolInfo[], skills: SkillInfo[], agents: AgentInfo[], workflows: WorkflowInfo[]) => void;
  toggleToolExpanded: (toolId: string) => void;
  toggleThinkingCollapsed: (nodeId: string) => void;
}

export const useStore = create<WebUIState>((set, get) => ({
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
  turnCount: 0,
  maxTurns: 20,
  tokensUsed: 0,
  maxTokens: 200000,
  cacheHitRate: null,
  compressCount: 0,
  permissionRequest: null,
  sessions: [],
  tools: [],
  skills: [],
  agents: [],
  workflows: [],

  addUserMsg(content: string) {
    const msg: UserMsgNode = { kind: 'user', content, id: uid() };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  appendText(content: string) {
    const { currentText, messages } = get();
    if (currentText === '' && messages.length > 0) {
      // 开始新的 assistant 消息段——先 flush pending thinking
      const { pendingThinking } = get();
      if (pendingThinking.trim()) {
        const thinkNode: ThinkingMsgNode = {
          kind: 'thinking',
          content: pendingThinking.trim(),
          id: uid(),
          collapsed: true,
        };
        set((s) => ({
          messages: [...s.messages, thinkNode],
          pendingThinking: '',
        }));
      }
    }
    set((s) => ({ currentText: s.currentText + content }));
  },

  appendThinking(content: string) {
    set((s) => ({ pendingThinking: s.pendingThinking + content }));
  },

  addToolCall(id: string, name: string, inputSummary: string) {
    // Flush pending thinking
    const { pendingThinking, currentText, messages } = get();
    const updates: Partial<WebUIState> = {};
    const newMsgs = [...messages];

    if (pendingThinking.trim()) {
      newMsgs.push({
        kind: 'thinking',
        content: pendingThinking.trim(),
        id: uid(),
        collapsed: true,
      });
      updates.pendingThinking = '';
    }
    if (currentText.trim()) {
      newMsgs.push({ kind: 'text', content: currentText.trim(), id: uid() });
      updates.currentText = '';
    }

    const node: ToolCallNode = {
      kind: 'tool',
      id: uid(),
      name,
      inputSummary,
      expanded: true,
    };
    newMsgs.push(node);

    const { activeToolIds } = get();
    const newMap = new Map(activeToolIds);
    newMap.set(id, node.id);
    updates.activeToolIds = newMap;

    set({ ...updates, messages: newMsgs } as Partial<WebUIState>);
  },

  completeToolCall(id: string, content: string, isError: boolean) {
    const { activeToolIds } = get();
    const displayId = activeToolIds.get(id);
    if (!displayId) return;

    set((s) => ({
      messages: s.messages.map((m) =>
        m.kind === 'tool' && m.id === displayId
          ? { ...m, result: content, isError }
          : m,
      ),
    }));
  },

  showDiff(id: string, filePath: string, diffLines) {
    const { activeToolIds } = get();
    const displayId = activeToolIds.get(id);
    if (!displayId) return;

    set((s) => ({
      messages: s.messages.map((m) =>
        m.kind === 'tool' && m.id === displayId
          ? { ...m, diff: { filePath, diffLines } }
          : m,
      ),
    }));
  },

  addSystemMsg(content: string, level: 'info' | 'warn' | 'error') {
    const msg: SystemMsgNode = { kind: 'system', content, level, id: uid() };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  startTurn() {
    // Flush any pending text
    const { currentText } = get();
    if (currentText.trim()) {
      set((s) => ({
        messages: [...s.messages, { kind: 'text', content: currentText.trim(), id: uid() }],
        currentText: '',
      }));
    }
    set({ isProcessing: true, currentText: '', currentThinking: '', pendingThinking: '' });
  },

  flushCurrent() {
    const { currentText, pendingThinking, messages } = get();
    const newMsgs = [...messages];

    if (pendingThinking.trim()) {
      newMsgs.push({
        kind: 'thinking',
        content: pendingThinking.trim(),
        id: uid(),
        collapsed: true,
      });
    }
    if (currentText.trim()) {
      newMsgs.push({ kind: 'text', content: currentText.trim(), id: uid() });
    }

    set({
      messages: newMsgs,
      currentText: '',
      pendingThinking: '',
      isProcessing: false,
    });
  },

  updateTurnInfo(info) {
    set({
      turnCount: info.turnCount,
      maxTurns: info.maxTurns,
      tokensUsed: info.tokensUsed,
      maxTokens: info.maxTokens,
      cacheHitRate: info.cacheHitRate,
      compressCount: info.compressCount,
    });
  },

  setPermission(req: PermissionRequestMsg | null) {
    set({ permissionRequest: req });
  },

  setConnected(sessionId: string, config) {
    set({ connected: true, sessionId, config });
  },

  setSessions(sessions: SessionInfo[]) {
    set({ sessions });
  },

  setCapabilities(tools: ToolInfo[], skills: SkillInfo[], agents: AgentInfo[], workflows: WorkflowInfo[]) {
    set({ tools, skills, agents, workflows });
  },

  toggleToolExpanded(toolId: string) {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.kind === 'tool' && m.id === toolId
          ? { ...m, expanded: !(m as ToolCallNode).expanded }
          : m,
      ),
    }));
  },

  toggleThinkingCollapsed(nodeId: string) {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.kind === 'thinking' && m.id === nodeId
          ? { ...m, collapsed: !(m as ThinkingMsgNode).collapsed }
          : m,
      ),
    }));
  },
}));
