/* ============================================================================
   Hyacinth WebUI v2 — 对话视图

   职责：消息流、输入、发送、停止、事件渲染。
   不做：标签管理（chat.js 内做，但只碰自己的 DOM）、会话列表（sessions.js）、
         模型选择（model.js）。

   会话身份（关键约束，读后端确认）：
     本页这条 WS 的 sessionId 是**握手时后端铸的**，前端改不了指向。
       ⇒ 要换会话只能换一条连接 = 换一个 iframe（由标签管理）。
     空会话 = 不带 session 参数的连接，后端 lazy 铸 id，首条消息才落盘。
       ⇒ 所以"新会话"不需要前端调 session.create。
   ========================================================================== */

import { client, appState } from '../main.js';
import { go } from '../core/router.js';

const MAX_TEXTAREA_H = 200;

let els = {};
let attached = false;
let currentAssistantEl = null;   // 流式输出时正在追加的那个气泡

export const chatView = {
  mount(host) {
    els = {
      root: host,
      messages: host.querySelector('#messages'),
      empty: host.querySelector('#empty-state'),
      input: host.querySelector('#input'),
      send: host.querySelector('#send-btn'),
      stop: host.querySelector('#stop-btn'),
      tabbar: host.querySelector('#tabbar'),
      tabList: host.querySelector('#tab-list'),
      tabNew: host.querySelector('#tab-new'),
      panes: host.querySelector('#panes'),
      surface: host.querySelector('#chat-surface'),
    };
    bindComposer();
    bindTabs();
    bindSuggestions();
  },

  refresh() {
    // 首次连上后会把历史拉回来；这里只处理"有会话时"的情况
    if (appState.sessionId) loadHistory();
  },

  attach() {
    if (attached) return;
    attached = true;
    // 连接就绪后才开始收事件
  },

  onEvent(type, payload) {
    switch (type) {
      case 'message.delta':
        appendDelta(payload);
        break;
      case 'message.done':
        finishMessage(payload);
        break;
      case 'turn.start':
        setRunning(true);
        break;
      case 'turn.end':
        setRunning(false);
        break;
      case 'session.title':
        setSessionTitle(payload?.title);
        break;
      default:
        break;
    }
  },
};

/* ── 输入区 ───────────────────────────────────────────────────────────── */
function bindComposer() {
  const { input, send, stop } = els;

  // 自适应高度：内容多则长高，到 200px 后内部滚动
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_TEXTAREA_H) + 'px';
    send.disabled = !input.value.trim();
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  send.addEventListener('click', sendMessage);
  stop.addEventListener('click', async () => {
    try { await client.request('message.stop', {}); } catch { /* 忽略 */ }
  });

  send.disabled = true;
}

function bindSuggestions() {
  for (const btn of els.root.querySelectorAll('.sug')) {
    btn.addEventListener('click', () => {
      els.input.value = btn.dataset.prompt || btn.textContent;
      els.input.dispatchEvent(new Event('input'));
      els.input.focus();
    });
  }
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || appState.running) return;

  els.input.value = '';
  els.input.dispatchEvent(new Event('input'));

  els.empty.hidden = true;
  els.messages.hidden = false;
  appendMessage('user', text);

  setRunning(true);
  try {
    await client.request('message.chat', { text });
  } catch (err) {
    setRunning(false);
    appendMessage('error', err?.message || '发送失败');
  }
}

/* ── 消息渲染 ─────────────────────────────────────────────────────────── */
function appendMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg--${role}`;

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;

  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  scrollToBottom();
  return body;
}

function appendDelta(payload) {
  const text = payload?.delta ?? payload?.text ?? '';
  if (!text) return;

  if (!currentAssistantEl) {
    currentAssistantEl = appendMessage('assistant', '');
  }
  currentAssistantEl.textContent += text;
  scrollToBottom();
}

function finishMessage(payload) {
  const full = payload?.text;
  if (full && currentAssistantEl) currentAssistantEl.textContent = full;
  currentAssistantEl = null;
  setRunning(false);
}

function setRunning(running) {
  appState.running = running;
  els.send.hidden = running;
  els.stop.hidden = !running;
  els.send.disabled = running || !els.input.value.trim();
}

function scrollToBottom() {
  const m = els.messages;
  // 只有本来就在底部附近时才自动跟随 —— 用户往上翻看历史时不打断他
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  if (nearBottom) m.scrollTop = m.scrollHeight;
}

async function loadHistory() {
  try {
    const res = await client.request('message.history', { sessionId: appState.sessionId });
    const list = res?.messages || res || [];
    if (!Array.isArray(list) || list.length === 0) return;

    els.messages.innerHTML = '';
    els.empty.hidden = true;
    els.messages.hidden = false;
    for (const m of list) {
      appendMessage(m.role === 'user' ? 'user' : 'assistant', m.content ?? m.text ?? '');
    }
  } catch {
    // 历史拉不到不是致命错误：新会话本来就没有
  }
}

function setSessionTitle(title) {
  if (!title) return;
  const active = els.tabList?.querySelector('.tab[aria-selected="true"] .tab-label');
  if (active) active.textContent = title;
}

/* ── 标签栏 ───────────────────────────────────────────────────────────────
   一条标签 = 一个 iframe = 一条 WS = 一个 AgentLoop。
   非活跃标签只 hidden 不卸载 ⇒ 任务继续跑。
   关标签 = frame.src='about:blank' ⇒ 文档卸载 ⇒ WS 断开 ⇒ 后端释放 loop。
   ──────────────────────────────────────────────────────────────────────── */
let tabs = [];
let activeTabId = null;

function bindTabs() {
  els.tabNew?.addEventListener('click', () => openTab(null));
  renderTabs();
}

export function openTab(sessionId) {
  const existing = sessionId && tabs.find((t) => t.sessionId === sessionId);
  if (existing) { activateTab(existing.id); return existing; }

  const id = 'tab-' + (tabs.length + 1) + '-' + Date.now().toString(36).slice(-4);
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.tabId = id;

  const frame = document.createElement('iframe');
  frame.className = 'pane-frame';
  // 不带 session 参数 ⇒ 后端铸 lazy id，首条消息才落盘
  const qs = new URLSearchParams({ embed: '1' });
  if (sessionId) qs.set('session', sessionId);
  frame.src = `/index.html?${qs.toString()}`;
  frame.setAttribute('title', sessionId || '新会话');
  pane.appendChild(frame);
  els.panes.appendChild(pane);

  const tab = {
    id,
    sessionId: sessionId || null,
    title: sessionId ? (sessionId.split('_').pop()?.slice(0, 12) || '会话') : '新会话',
    running: false,
    pane,
    frame,
  };
  tabs.push(tab);
  activateTab(id);
  return tab;
}

function activateTab(id) {
  activeTabId = id;
  for (const t of tabs) t.pane.hidden = t.id !== id;
  renderTabs();
}

export function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];

  // 先导航走再删：文档卸载立即断开这条 WS，后端随即释放会话占用
  try { tab.frame.src = 'about:blank'; } catch { /* ignore */ }
  tab.pane.remove();
  tabs.splice(idx, 1);

  if (activeTabId === id) {
    const next = tabs[idx - 1] || tabs[idx] || tabs[0];
    if (next) activateTab(next.id);
    else activeTabId = null;
  }
  renderTabs();
}

function renderTabs() {
  if (!els.tabbar) return;
  // 空时不占位（v1 在这里留了一条只有 + 的空白横条）
  els.tabbar.hidden = tabs.length === 0 && !appState.sessionId;
  els.tabList.innerHTML = '';

  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(t.id === activeTabId));

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = t.title;
    btn.appendChild(label);

    if (t.running) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      btn.appendChild(dot);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭标签');
    close.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
    btn.appendChild(close);

    btn.addEventListener('click', () => activateTab(t.id));
    els.tabList.appendChild(btn);
  }
}
