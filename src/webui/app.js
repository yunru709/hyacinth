/* Hyacinth WebUI — SPA 单页应用
 * ----------------------------------------------------------------
 * 基于桌面 hyacinth-webui 设计稿合并生成（见 build-webui-spa.cjs）。
 * 职责：
 *   1. 接入协议层（WS /ui，7 域 + schedule 域）
 *   2. hash 路由：#/chat #/model #/sessions #/settings #/companion（切换不刷新）
 *   3. 共享 shell 状态：header 模型 chip / Context 进度条 / Online / 版本号
 *   4. chat 视图：发送 / 接收 / 历史渲染（message 域事件流）
 *   5. Lucide 图标本地初始化
 * ---------------------------------------------------------------- */
(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // 协议客户端（WS /ui）
  // ════════════════════════════════════════════════════════════
  class ProtocolClient {
    constructor(url, handlers) {
      this.url = url;
      this.handlers = handlers || {};
      this.pending = new Map(); // id → {resolve, reject}
      this.seq = 0;
      this.ws = null;
      this.connected = false;
      this.reconnectTimer = null;
      this.reconnectDelay = 1000;
      this.closed = false; // 手动 close 后不再重连
    }

    connect() {
      if (this.closed) return;
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        this.handlers.onOpen && this.handlers.onOpen();
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.dispatch(msg);
      };

      ws.onclose = () => {
        this.connected = false;
        this.handlers.onClose && this.handlers.onClose();
        // 自动重连（退避 1s→2s→4s→…上限 10s）
        if (!this.closed) {
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
        }
      };

      ws.onerror = () => {
        this.handlers.onError && this.handlers.onError();
      };
    }

    close() {
      this.closed = true;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      if (this.ws) this.ws.close();
    }

    dispatch(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'response') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(msg.error || { code: 'ERROR', message: 'unknown error' });
        }
      } else if (msg.kind === 'event') {
        this.handlers.onEvent && this.handlers.onEvent(msg.type, msg.payload);
      }
    }

    request(method, params) {
      return new Promise((resolve, reject) => {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject({ code: 'NOT_CONNECTED', message: '连接未建立' });
          return;
        }
        const id = 'r' + (++this.seq);
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ kind: 'request', id, method, params }));
      });
    }

    close() {
      if (this.ws) this.ws.close();
    }
  }

  // ════════════════════════════════════════════════════════════
  // DOM 助手
  // ════════════════════════════════════════════════════════════
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function fmtTokens(n) {
    if (n == null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  // ════════════════════════════════════════════════════════════
  // 共享状态
  // ════════════════════════════════════════════════════════════
  let currentSessionId = null;
  let connected = false;
  let startupModeApplied = false; // 启动默认模式只自动进入一次（用户切走不拉回）

  // ════════════════════════════════════════════════════════════
  // SPA hash 路由
  // ════════════════════════════════════════════════════════════
  const VIEWS = ['chat', 'model', 'sessions', 'settings', 'companion'];
  // data-view → data-nav-item 映射（导航里 model 对应 models）
  const NAV_BY_VIEW = { chat: 'chat', model: 'models', sessions: 'sessions', settings: 'settings' };

  function currentView() {
    const h = (location.hash || '#/chat').replace(/^#\//, '');
    return VIEWS.includes(h) ? h : 'chat';
  }

  function applyView(view) {
    // 视图 section 显隐
    $$('.view-section').forEach((sec) => {
      sec.hidden = sec.dataset.view !== view;
    });
    // companion 是沉浸式全屏视图（在 app-shell 外）：切换时隐藏 shell
    const shell = $('#app-shell');
    if (shell) shell.hidden = view === 'companion';
    // 导航高亮
    $$('[data-nav-item]').forEach((a) => {
      a.classList.toggle('nav-active', a.dataset.navItem === NAV_BY_VIEW[view]);
    });
    // 确保图标渲染（切换后新显示区域）
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    // 视图数据加载钩子
    if (view === 'chat' && connected) loadHistory();
    if (view === 'model' && connected) loadModel();
    if (view === 'sessions' && connected) loadSessions();
    if (view === 'settings' && connected) loadSettings();
    if (view === 'settings' && connected) loadToolsAndMCP();
    if (view === 'companion' && connected) loadCompanion();
    // 离开陪伴视图：停场景轮询、清 live 场景状态（下次进入重新加载）
    if (view !== 'companion') {
      if (companionScenePollTimer) {
        clearInterval(companionScenePollTimer);
        companionScenePollTimer = null;
      }
      companionLiveScene = null;
      companionLiveSceneSig = '';
    }
  }

  function navigate() {
    applyView(currentView());
  }

  // 统一导航：hash 相同时手动刷新（hashchange 不触发），否则设置 hash 触发事件
  function goTo(hash) {
    if (location.hash === hash) {
      navigate();
    } else {
      location.hash = hash;
    }
  }

  // ════════════════════════════════════════════════════════════
  // 连接状态 / header 状态
  // ════════════════════════════════════════════════════════════
  /** 状态: 'connected' | 'disconnected' | 'reconnecting' */
  function setOnline(state) {
    const dot = $('#header-online-dot');
    const text = $('#header-online-text');
    const wrap = $('#header-online');
    if (!dot || !text) return;
    // 用内联样式设颜色（避免 Tailwind JIT 不识别动态 className）
    const map = {
      connected:     { color: '#22c55e', text: 'Online',       title: '已连接后端', textColor: '#86efac' },
      disconnected:  { color: '#ef4444', text: '离线',         title: '后端连接断开，正在重连…', textColor: '#fca5a5' },
      reconnecting:  { color: '#eab308', text: '重连中…',      title: '正在重新连接后端…', textColor: '#fde047' },
    };
    const s = map[state] || map.disconnected;
    dot.style.backgroundColor = s.color;
    text.textContent = s.text;
    text.style.color = s.textColor;
    if (wrap) wrap.title = s.title;
  }

  // 重连只保留 ProtocolClient 内部一层（指数退避 1s→10s）。
  // 旧实现模块级还有一层 scheduleReconnect，与内部重连并行 → 重连风暴。
  // 这里仅保留状态提示与退避重置的粘合（setOnline / resetReconnect）。
  function resetReconnect() {
    // ProtocolClient.onopen 时把自身退避重置为 1s，无需额外处理；
    // 保留空函数以兼容既有调用点（ui.connected）。
  }

  // 上一次的上限（迭代级 context_update 不带该字段 ⇒ 靠 state.update 记下来 ✓）
  let lastMaxContextTokens = 0;

  /**
   * 迭代级上下文刷新 —— 接 `message.context_update` ✓
   * 此前前端**没有这个分支** ✗ ⇒ 长回合里进度条不动（只在回合结束跳一下 ✗）。
   * 语义：**每轮迭代都发、不表示回合结束**（与 state.update 的区别就在这 ✓）。
   */
  function applyContextUpdate(p) {
    if (!p) return;
    const used = p.tokensUsed != null ? p.tokensUsed : null;
    const max = lastMaxContextTokens || 0;
    const bar = $('#header-context-bar');
    const text = $('#header-context-text');
    if (used != null && max > 0 && bar) {
      bar.style.width = Math.max(0, Math.min(100, (used / max) * 100)) + '%';
    }
    if (used != null && text) text.textContent = `${fmtTokens(used)} / ${fmtTokens(max)}`;
  }

  function updateHeader(snap) {
    if (!snap) return;
    const name = $('#header-model-name');
    const provider = $('#header-model-provider');
    const bar = $('#header-context-bar');
    const text = $('#header-context-text');
    if (name) name.textContent = snap.model || '—';
    if (provider) provider.textContent = snap.providerLabel || snap.provider || '—';
    const pct = snap.contextUsagePct != null ? snap.contextUsagePct : 0;
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (text) text.textContent = `${fmtTokens(snap.tokensUsed)} / ${fmtTokens(snap.maxContextTokens)}`;
    if (snap.maxContextTokens) lastMaxContextTokens = snap.maxContextTokens;   // 供迭代级刷新复用 ✓
  }

  // ════════════════════════════════════════════════════════════
  // chat 视图渲染（message-list 目标：与桌面设计稿气泡样式一致）
  // ════════════════════════════════════════════════════════════
  function clearChat() {
    const ml = $('#message-list');
    if (ml) ml.innerHTML = '';
    histPending = [];
  }

  function scrollChat() {
    const ml = $('#message-list');
    if (ml) ml.scrollTop = ml.scrollHeight;
  }

  function bubbleUser(text) {
    const wrap = el('div', 'flex justify-end');
    const b = el('div', 'max-w-[85%] md:max-w-[70%] message-bubble rounded-xl px-4 py-2.5 bg-primary text-primary-foreground shadow-sm');
    b.appendChild(el('p', 'text-sm leading-relaxed', text));
    b.appendChild(el('span', 'block mt-1.5 text-[10px] text-primary-foreground/70 text-right', nowTime()));
    wrap.appendChild(b);
    return wrap;
  }

  function bubbleAssistant(text) {
    const wrap = el('div', 'flex justify-start gap-3');
    const avatar = el('div', 'w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-1');
    avatar.innerHTML = '<i data-lucide="bot-message-square" class="w-4 h-4 text-primary"></i>';
    const body = el('div', 'max-w-[90%] md:max-w-[75%] space-y-3');
    const b = el('div', 'message-bubble rounded-xl px-4 py-3 bg-card border border-border text-foreground shadow-sm');
    b.innerHTML = `<p class="text-sm leading-relaxed">${esc(text)}</p>`;
    body.appendChild(b);
    body.appendChild(el('span', 'block text-[10px] text-muted-foreground', nowTime()));
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  function bubbleThinking(text) {
    const wrap = el('div', 'flex justify-start gap-3');
    const avatar = el('div', 'w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-1');
    avatar.innerHTML = '<i data-lucide="bot-message-square" class="w-4 h-4 text-primary"></i>';
    const body = el('div', 'max-w-[90%] md:max-w-[75%]');
    body.appendChild(el('div', 'text-xs text-muted-foreground', '💭 ' + (text || '思考中…')));
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  function bubbleTool(name, detail) {
    const wrap = el('div', 'flex justify-start gap-3');
    const avatar = el('div', 'w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center shrink-0 mt-1');
    avatar.innerHTML = '<i data-lucide="wrench" class="w-4 h-4 text-muted-foreground"></i>';
    const card = el('details', 'group max-w-[90%] md:max-w-[75%] w-full rounded-xl border border-border bg-card shadow-sm overflow-hidden');
    const summary = el('summary', 'flex items-center justify-between px-3 py-2 cursor-pointer list-none hover:bg-muted/50 transition-colors');
    summary.innerHTML = `<div class="flex items-center gap-2.5"><i data-lucide="terminal" class="w-4 h-4 text-accent"></i><span class="text-sm font-medium">${esc(name)}</span></div><i data-lucide="chevron-right" class="w-4 h-4 text-muted-foreground group-open:rotate-90 transition-transform"></i>`;
    card.appendChild(summary);
    card.appendChild(el('div', 'border-t border-border px-3 py-2 text-xs text-muted-foreground', detail || ''));
    wrap.appendChild(avatar);
    wrap.appendChild(card);
    return wrap;
  }

  function bubbleSystem(text) {
    const wrap = el('div', 'flex justify-center');
    wrap.appendChild(el('div', 'text-[11px] text-muted-foreground bg-muted/50 px-3 py-1 rounded-full', text));
    return wrap;
  }

  function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function appendMsg(kind, text) {
    const ml = $('#message-list');
    if (!ml) return;
    let node;
    switch (kind) {
      case 'user': node = bubbleUser(text); break;
      case 'assistant': node = bubbleAssistant(text); break;
      case 'thinking': node = bubbleThinking(text); break;
      case 'tool': {
        const line = String(text || '');
        const m = line.match(/^(.+?)(?:\(([^)]*)\))?$/);
        node = bubbleTool(m ? m[1] : '工具', m ? m[2] : line);
        break;
      }
      case 'error': node = bubbleSystem('⚠️ ' + text); break;
      default: node = bubbleSystem(text); break;
    }
    ml.appendChild(node);
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    scrollChat();
  }

  // ── 流式助手气泡（message.text 是流式事件，追加到同一气泡）──
  let streamingAssistant = null;

  function appendAssistantStream(content) {
    const ml = $('#message-list');
    if (!ml) return;
    if (!streamingAssistant || !streamingAssistant.isConnected) {
      streamingAssistant = bubbleAssistant('');
      ml.appendChild(streamingAssistant);
    }
    const p = streamingAssistant.querySelector('p');
    if (p) p.textContent += content || '';
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    scrollChat();
  }

  function resetStreaming() {
    streamingAssistant = null;
  }

  // ── 历史渲染（协议 message.history 返回 HistoryMessage[]）──
  // ── 历史回放的「过程缓冲」（与实时路径同一套折叠规则 ✓）──────────────
  // 实测事实（读真实 events.jsonl ✓）：交付正文**没有独立 text 事件**，
  // 它藏在 say 的 tool_call 里（input.content）⇒ 原先一律当折叠小条渲染，
  // 于是刷新后**回复被埋在 JSON 里** ✗ ⇒ 现在认出 say 并单独渲染 ✓
  let histPending = [];   // 延迟渲染：折不折叠取决于「后面有没有交付」✓

  function histPush(node) { if (node) histPending.push(node); }

  /** 冲刷过程块：collapse=true（后面有交付）⇒ 收起；false ⇒ **保持展开**（不藏正文 ✓） */
  function flushHistoryProcess(collapse) {
    if (!histPending.length) return;
    const ml = $('#message-list');
    if (ml) {
      const det = el('details', 'process-group');
      det.open = !collapse;
      det.appendChild(el('summary', '', `过程（${histPending.length}）`));
      const body = el('div', 'process-body');
      for (const n of histPending) body.appendChild(n);
      det.appendChild(body);
      ml.appendChild(det);
    }
    histPending = [];
  }

  /** 从历史条目里取出「交付正文」（只认 say 的 tool_call ✓） */
  function historySayText(m) {
    if (!m || m.type !== 'tool_call' || m.name !== 'say') return null;
    const raw = m.input && typeof m.input === 'object' ? m.input.content : null;
    return typeof raw === 'string' && raw.trim() ? raw : null;
  }

  function renderHistoryMsg(m) {
    const ml = $('#message-list');
    if (!ml) return;
    // ① say 交付 ⇒ 醒目气泡，并把之前累积的过程收起 ✓
    const sayText = historySayText(m);
    if (sayText) {
      flushHistoryProcess(true);
      const dwrap = bubbleAssistant(sayText);
      dwrap.classList.add('msg-delivery');
      ml.appendChild(dwrap);
      return;
    }
    // ② say 的工具回执只是 ok 噪音 ⇒ 跳过 ✓
    if (m && m.type === 'tool_result' && m.name === 'say') return;
    const type = m && m.type;
    const content = (m && (m.content || m.text)) || '';
    switch (type) {
      case 'user_input':
      case 'user':
        flushHistoryProcess(false);
        ml.appendChild(bubbleUser(content));
        break;
      case 'text':
      case 'assistant':
        histPush(el('div', 'process-text', content));
        break;
      case 'thinking':
        histPush(bubbleThinking(content));
        break;
      case 'tool_call':
        histPush(bubbleTool(
          (m && m.name) || '工具',
          (m && (m.inputSummary || (m.input ? JSON.stringify(m.input) : ''))) || content
        ));
        break;
      case 'tool_result':
        histPush(bubbleSystem('  ↳ ' + content));
        break;
      case 'system':
      case 'status':
        histPush(bubbleSystem(content));
        break;
      case 'error':
        histPush(bubbleSystem('⚠️ ' + content));
        break;
      case 'stop':
      case 'usage':
      case 'session_start':
      case 'session_end':
        break; // 结束/用量/会话标记不渲染
      default:
        // 未知类型：仅当有实际内容才按助手消息渲染
        if (content) histPush(el('div', 'process-text', content));
        break;
    }
  }

  async function loadHistory() {
    if (!connected || !currentSessionId) return;
    try {
      const res = await client.request('message.history', { sessionId: currentSessionId });
      const msgs = (res && res.messages) || [];
      clearChat();
      if (companionActive) {
        // 陪伴会话的内容只属于陪伴视图：主界面不渲染历史，仅提示去向
        appendMsg('system', '陪伴会话进行中——对话内容请在陪伴模式页查看');
        scrollChat();
        return;
      }
      msgs.forEach(renderHistoryMsg);
      flushHistoryProcess(false);
      scrollChat();
    } catch (e) {
      // 历史加载失败静默（聊天可继续发送）
    }
  }

  // ════════════════════════════════════════════════════════════
  // 事件分发（协议层 event → 视图）
  // ════════════════════════════════════════════════════════════
  // ── 回合「过程」折叠块（用户 2026-09-20 要求：中间过程允许折叠 ✓）────────
  // 背景：`say`（交付结论）与「过程」（思考 / 流式文本 / 工具调用 / 状态）原先混在同一
  // 列表里；而 **`message.say` 事件前端根本没处理** ✗ ⇒ 用户看不到最终输出 ✓
  // （后端早已发出：events.ts MESSAGE_SAY ⇐ message.ts onSay() ⇐ loop.ts onSay(pending)）
  // 设计：过程收进 <details>，**默认展开**（保底：某回合没调 say 时正文仍看得见 ✓）；
  //      `say` 到达时自动收起 ⇒「最终输出」醒目、「中间过程」可折叠 ✓
  let turnProcessBody = null;
  let processTextNode = null;

  function resetProcessGroup() {
    turnProcessBody = null;
    processTextNode = null;
  }

  function ensureProcessBody() {
    const ml = $('#message-list');
    if (!ml) return null;
    if (turnProcessBody && turnProcessBody.isConnected) return turnProcessBody;
    const det = el('details', 'process-group');
    det.open = true;                    // 默认展开 ⇒ 万一本回合没有 say，正文仍看得见 ✓
    det.appendChild(el('summary', '', '过程'));
    const body = el('div', 'process-body');
    det.appendChild(body);
    ml.appendChild(det);
    turnProcessBody = body;
    processTextNode = null;
    return body;
  }

  /** 往「过程」块里追加一个节点，并刷新摘要里的条数 ✓ */
  function appendProcess(node) {
    const body = ensureProcessBody();
    if (!body) return;
    body.appendChild(node);
    const det = body.parentElement;
    const summary = det && det.querySelector ? det.querySelector('summary') : null;
    if (summary) summary.textContent = `过程（${body.children.length}）`;
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    scrollChat();
  }

  /** 流式文本：累积进「过程」块里的同一条（不是每条事件各起一个气泡 ✓） */
  function appendProcessText(content) {
    if (!content) return;
    if (!processTextNode || !processTextNode.isConnected) {
      processTextNode = el('div', 'process-text', '');
      appendProcess(processTextNode);
    }
    processTextNode.textContent += content;
    scrollChat();
  }

  /** 收起「过程」块（`say` 交付到达时调用 ✓） */
  function collapseProcessGroup() {
    const body = turnProcessBody;
    const det = body && body.parentElement;
    if (det && det.tagName === 'DETAILS') det.open = false;
  }

  function handleEvent(type, payload) {
    switch (type) {
      case 'ui.connected':
        if (payload && payload.sessionId) currentSessionId = payload.sessionId;
        connected = true;
        setOnline('connected');
        resetReconnect();
        loadHistory();
        if (currentView() === 'model') loadModel();
        if (currentView() === 'sessions') loadSessions();
        if (currentView() === 'settings') { loadSettings(); loadToolsAndMCP(); loadVoiceManager(); }
        if (currentView() === 'companion') loadCompanion();
        refreshState();
        // 同步陪伴模式状态（后端可能因 startup.defaultMode='companion' 已激活）
        client.request('companion.get').then((res) => {
          if (res && res.active) {
            companionActive = true;
            companionCharacter = res.character || '';
            updateCompanionButton();
          }
        }).catch(() => {});
        // 启动默认模式：startup.defaultMode=陪伴模式 → UI 启动即进入陪伴视图
        //（一次性；进入后 loadCompanion 会经协议层激活后端 Router。用户切走不拉回）
        if (!startupModeApplied) {
          startupModeApplied = true;
          client.request('config.get', { path: 'startup.defaultMode' }).then((r) => {
            const mode = (r && r.value) || 'normal';
            try { localStorage.setItem('hyacinth.startupMode', mode); } catch (e) { /* ignore */ }
            if (mode === 'companion' && currentView() === 'chat') goTo('#/companion');
          }).catch(() => {});
        }
        break;
      case 'message.turn_start':
        resetStreaming();
        resetProcessGroup();   // 新回合 ⇒ 「过程」块另起一块 ✓
        showThinking(true);
        if (currentView() === 'companion') companionResetDialogue('…');
        break;
      case 'message.text':
        showThinking(false);
        if (currentView() === 'companion') {
          // 表达契约：普通 text 是内心独白，不上对话框；台词只来自 companion.say 事件
        } else if (companionActive) {
          // 陪伴会话的内容只属于陪伴视图：主界面不渲染（流式也不进）
        } else {
          appendProcessText(payload && payload.content);
        }
        break;
      case 'message.say': {
        // ★ say = 交付结论（模型的"嘴"）。后端一直在发这个事件，而前端此前**没有这个分支** ✗
        //   ⇒「最终输出看不到」的根因就在这一处 ✓（TUI 走 onText 回退路，所以它显示得出来）
        //   现在：渲染成**醒目的交付气泡**，并把本回合的「过程」块自动收起 ✓
        showThinking(false);
        resetStreaming();
        if (companionActive) break;      // 陪伴会话走 companion.say，不进主界面 ✓
        const sayText = (payload && payload.content) || '';
        if (sayText) {
          const wrap = bubbleAssistant(sayText);
          wrap.classList.add('msg-delivery');   // 专属样式 ⇒ 一眼看出"这是交付" ✓
          const ml = $('#message-list');
          if (ml) ml.appendChild(wrap);
        }
        collapseProcessGroup();
        resetProcessGroup();             // 交付之后若还有过程，另起一块 ✓
        if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
        scrollChat();
        break;
      }
      case 'companion.say':
        handleCompanionSay(payload);
        break;
      case 'message.thinking':
        if (companionActive) break; // 陪伴会话的思考流不进主界面
        showThinking(true, (payload && payload.content) || '思考中…');
        if (currentView() === 'companion') companionSetDialogue('💭 ' + ((payload && payload.content) || '思考中…'));
        break;
      case 'message.tool_use':
        showThinking(false);
        if (companionActive) break; // 陪伴会话的工具调用在陪伴视图呈现
        appendProcess(bubbleTool((payload && payload.name) || '工具', (payload && payload.inputSummary) || ''));
        break;
      case 'message.tool_result':
        if (companionActive) break;
        // 工具级错误通过 isError 标志醒目显示（不触发回合级 message.error，避免误 resetStreaming）
        if (payload && payload.isError) {
          appendProcess(bubbleSystem('⚠️  ↳ ' + ((payload && payload.content) || '')));
        } else {
          appendProcess(bubbleSystem('  ↳ ' + ((payload && payload.content) || '')));
        }
        break;
      case 'message.status': {
        const msg = (payload && payload.message) || '';
        const level = (payload && payload.level) || 'info';
        // 过滤旁路 agent 内部标记，不渲染到聊天区
        if (msg === 'bypass-start' || msg === 'bypass-end') break;
        appendProcess(bubbleSystem(`[${level}] ${msg}`));
        break;
      }
      case 'message.error':
        showThinking(false);
        resetStreaming();
        if (currentView() === 'companion') {
          companionSetDialogue('⚠️ ' + ((payload && payload.message) || '未知错误'));
        } else {
          appendMsg('error', (payload && payload.message) || '未知错误');
        }
        break;
      case 'message.interrupt':
        showThinking(false);
        resetStreaming();
        setBusy(false);
        if (currentView() === 'companion') {
          companionSetDialogue('⏹ 已中断');
        } else {
          appendMsg('system', '⏹ 已中断');
        }
        break;
      case 'message.flush':
        showThinking(false);
        resetStreaming();
        if (currentView() === 'companion') companionResetDialogue(companionDialogueBuf);
        break;
      case 'message.diff':
        showThinking(false);
        appendDiff(payload);
        break;
      case 'message.turn_info':
        // 回合 token 信息由 state.update 覆盖状态栏
        resetStreaming();
        setBusy(false);
        break;
      case 'message.ask_user':
        showAskUser(payload);
        break;
      case 'message.context_update':
        // 迭代级：每轮迭代都发 ⇒ 进度条**实时**动 ✓（不表示回合结束 ✓）
        applyContextUpdate(payload);
        break;
      case 'state.update':
        updateHeader(payload);
        break;
      case 'session.change':
        currentSessionId = (payload && payload.sessionId) || currentSessionId;
        break;
      case 'model.change':
        refreshState();
        if (currentView() === 'model') loadModel();
        break;
      case 'config.change':
        if (currentView() === 'settings') loadSettings();
        break;
      case 'companion.voice':
        handleCompanionVoice(payload);
        break;
      case 'permission.request':
        showPermission(payload);
        break;
      case 'ui.error':
        showThinking(false);
        appendMsg('error', (payload && payload.message) || '后端错误');
        break;
      default:
        break;
    }
  }

  // ── thinking 指示器（动态插入 message-list，桌面风格）──
  let thinkingEl = null;

  function showThinking(on, text) {
    const ml = $('#message-list');
    if (!ml) return;
    if (!on) { hideThinking(); return; }
    if (!thinkingEl || !thinkingEl.isConnected) {
      thinkingEl = el('div', 'flex justify-start gap-3');
      thinkingEl.innerHTML =
        '<div class="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-1">' +
        '<i data-lucide="bot-message-square" class="w-4 h-4 text-primary"></i></div>' +
        '<div class="flex items-center gap-2 px-3 py-2 rounded-xl bg-card border border-border text-muted-foreground">' +
        '<span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>' +
        '<span class="text-xs">Assistant 正在思考…</span></div>';
      ml.appendChild(thinkingEl);
    }
    const txt = thinkingEl.querySelector('span.text-xs');
    if (txt) txt.textContent = text || 'Assistant 正在思考…';
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    scrollChat();
  }

  function hideThinking() {
    if (thinkingEl && thinkingEl.isConnected) thinkingEl.remove();
    thinkingEl = null;
  }

  // ── diff 渲染（message.diff → 代码 diff 卡片）──
  function appendDiff(payload) {
    const ml = $('#message-list');
    if (!ml) return;
    const wrap = el('div', 'flex justify-start gap-3');
    const avatar = el('div', 'w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center shrink-0 mt-1');
    avatar.innerHTML = '<i data-lucide="git-diff" class="w-4 h-4 text-muted-foreground"></i>';
    const card = el('details', 'group max-w-[90%] md:max-w-[75%] w-full rounded-xl border border-border bg-card shadow-sm overflow-hidden');
    card.open = true;
    const summary = el('summary', 'flex items-center justify-between px-3 py-2 cursor-pointer list-none hover:bg-muted/50 transition-colors');
    summary.innerHTML =
      '<div class="flex items-center gap-2.5"><i data-lucide="file-code-2" class="w-4 h-4 text-primary"></i>' +
      `<span class="text-sm font-medium">${esc((payload && payload.filePath) || 'diff')}</span></div>` +
      '<i data-lucide="chevron-right" class="w-4 h-4 text-muted-foreground group-open:rotate-90 transition-transform"></i>';
    card.appendChild(summary);
    const body = el('div', 'border-t border-border px-0 py-0');
    const pre = el('pre', 'message-code p-3 text-xs font-mono bg-muted/50 overflow-x-auto');
    pre.innerHTML = ((payload && payload.diffLines) || []).map((l) => {
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const cls = l.kind === 'add' ? 'text-green-600' : l.kind === 'del' ? 'text-red-500' : 'text-foreground/80';
      return `<div class="${cls}">${esc(sign + ' ' + l.text)}</div>`;
    }).join('');
    body.appendChild(pre);
    card.appendChild(body);
    wrap.appendChild(avatar);
    wrap.appendChild(card);
    ml.appendChild(wrap);
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    scrollChat();
  }

  // ── permission 对话框（permission.request → resolve）──
  let pendingPerm = null;

  function showPermission(payload) {
    if (!payload) return;
    pendingPerm = payload;
    const t = $('#permission-text');
    if (t) t.textContent = `${payload.toolName} 请求执行权限`;
    const d = $('#permission-dialog');
    if (d) d.hidden = false;
  }

  function resolvePermission(result) {
    const d = $('#permission-dialog');
    if (d) d.hidden = true;
    if (pendingPerm) {
      client.request('permission.resolve', { id: pendingPerm.id, result }).catch(() => {});
      pendingPerm = null;
    }
  }

  // ── ask_user 对话框（message.ask_user → askUserResolve）──
  let pendingAsk = null;

  function showAskUser(payload) {
    if (!payload || !payload.questions) return;
    pendingAsk = payload;
    const box = $('#askuser-questions');
    if (!box) return;
    box.innerHTML = '';
    (payload.questions || []).forEach((q, i) => {
      const field = el('div', 'ask-field');
      field.appendChild(el('label', 'ask-q', `${i + 1}. ${q.question}`));
      if (q.options && q.options.length) {
        const sel = el('select');
        (q.options || []).forEach((o) => {
          const opt = el('option', '', o);
          sel.appendChild(opt);
        });
        field.appendChild(sel);
      }
      if (q.customInput !== false) {
        const input = el('input');
        input.type = 'text';
        input.placeholder = q.customInput === true ? '输入…' : '自定义输入（可选）';
        field.appendChild(input);
      }
      box.appendChild(field);
    });
    const d = $('#askuser-dialog');
    if (d) d.hidden = false;
  }

  function resolveAskUser() {
    if (!pendingAsk) return;
    const { id, questions } = pendingAsk;
    const fields = $$('#askuser-questions .ask-field');
    const result = {};
    (questions || []).forEach((q, i) => {
      const field = fields[i];
      if (!field) return;
      const answers = [];
      const sel = field.querySelector('select');
      if (sel && sel.value) answers.push(sel.value);
      const input = field.querySelector('input');
      if (input && input.value.trim()) answers.push(input.value.trim());
      if (answers.length > 0) result[q.question] = answers;
    });
    const d = $('#askuser-dialog');
    if (d) d.hidden = true;
    pendingAsk = null;
    client.request('message.askUserResolve', { id, answer: JSON.stringify(result, null, 2) })
      .catch((e) => appendMsg('error', `ask_user 应答失败: ${e && e.message}`));
  }

  // ── 发送/停止按钮状态 ──
  function setBusy(busy) {
    const send = $('#chat-send-btn');
    const stop = $('#chat-stop-btn');
    if (send) send.hidden = busy;
    if (stop) stop.hidden = !busy;
  }

  async function refreshState() {
    try {
      const snap = await client.request('state.get');
      updateHeader(snap);
    } catch (e) { /* ignore */ }
  }

  // ════════════════════════════════════════════════════════════
  // 模型视图（model 域渲染与交互）
  // ════════════════════════════════════════════════════════════
  const PROVIDER_ICONS = {
    anthropic: 'bot', openai: 'cloud', google: 'sparkles', mistral: 'wind',
    cohere: 'network', groq: 'zap', deepseek: 'cpu', qwen: 'cloud',
    ollama: 'box', llamacpp: 'box', local: 'hard-drive',
  };
  const REASONING_DESC = {
    low: '低强度优先响应速度，适合简单问答与短任务。',
    medium: '中等强度在响应速度与复杂推理之间取得平衡。',
    high: '高强度投入更多推理步骤，适合复杂代码与深度分析。',
  };

  async function loadModel() {
    if (!connected) return;
    try {
      const [prov, chans, loc, act] = await Promise.all([
        client.request('model.listProviders'),
        client.request('model.listChannels'),
        client.request('model.listLocalModels'),
        client.request('model.getActive'),
      ]);
      renderProviders((prov && prov.providers) || []);
      renderChannels((chans && chans.channels) || []);
      renderLocalModels((loc && loc.models) || []);
      updateActiveCard(act);
    } catch (e) { /* ignore */ }
  }

  function updateActiveCard(act) {
    if (!act) return;
    const name = $('#model-active-name');
    const via = $('#model-active-via');
    const id = $('#model-active-id');
    const ctx = $('#model-active-ctx');
    if (name) name.textContent = act.model || act.provider || '—';
    if (via) via.textContent = 'via ' + (act.providerLabel || act.provider || '');
    if (id) id.textContent = act.model || '';
    if (ctx) ctx.textContent = act.maxContextTokens ? `上下文 ${fmtTokens(act.maxContextTokens)}` : '';
  }

  function renderProviders(providers) {
    const grid = $('#model-provider-grid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!providers.length) {
      grid.appendChild(el('div', 'text-xs text-muted-foreground col-span-full', '暂无在线提供商'));
      return;
    }
    providers.forEach((p) => {
      const card = el('article', 'bg-card border border-border rounded-lg p-4 flex flex-col gap-3');
      const head = el('div', 'flex items-center justify-between');
      const left = el('div', 'flex items-center gap-2');
      const iconBox = el('div', 'w-8 h-8 rounded-md bg-muted flex items-center justify-center text-primary');
      iconBox.innerHTML = `<i data-lucide="${PROVIDER_ICONS[p.type] || 'cloud'}" class="w-4 h-4"></i>`;
      const titleBox = el('div');
      titleBox.appendChild(el('div', 'text-sm font-semibold text-foreground', p.label || p.type));
      // 纯映射：协议层已派生 status，前端不做业务判断
      const STATUS = {
        active:      { text: '当前启用', cls: 'text-primary', dot: 'bg-state-success' },
        local:       { text: '本地模型', cls: 'text-muted-foreground', dot: 'bg-muted-foreground' },
        configured:  { text: 'API 密钥已配置', cls: 'text-muted-foreground', dot: 'bg-muted-foreground' },
        unconfigured:{ text: '未配置密钥', cls: 'text-state-warning', dot: 'bg-state-error' },
      };
      const st = STATUS[p.status] || STATUS.unconfigured;
      titleBox.appendChild(el('div', `text-xs ${st.cls}`, st.text));
      left.appendChild(iconBox);
      left.appendChild(titleBox);
      head.appendChild(left);
      head.appendChild(el('span', `w-2 h-2 rounded-full ${st.dot}`));
      card.appendChild(head);
      if (p.model) {
        const modelRow = el('div', 'text-xs text-muted-foreground space-y-0.5');
        modelRow.appendChild(el('div', 'flex items-center justify-between', p.model));
        card.appendChild(modelRow);
      }
      // 按钮：active 禁用，unconfigured 引导配置密钥，其余切换
      const isUnconfigured = p.status === 'unconfigured';
      const isActive = p.status === 'active';
      const switchBtn = el('button',
        `mt-auto w-full text-xs px-3 py-2 rounded-md border ${isActive ? 'border-primary/30 text-primary' : 'border-border bg-card text-foreground hover:bg-muted'} transition-colors`,
        isActive ? '当前启用' : (isUnconfigured ? '配置密钥' : '切换'));
      switchBtn.onclick = () => {
        if (isUnconfigured) {
          showAddKeyDialog(p.type);
          return;
        }
        client.request('model.switch', { provider: p.type, model: p.model }).then(() => {
          loadModel();
          refreshState();
        }).catch((e) => appendMsg('error', `切换失败: ${e && e.message}`));
      };
      card.appendChild(switchBtn);
      grid.appendChild(card);
    });
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  /**
   * 通道行操作 —— 接 model.setChannelModel / resetChannelModel / removeChannel ✓
   * 优先用**行内表单**（点「改模型」在本行展开两个输入框 ✓）。
   * ⚠️ 刻意不用 window.prompt ✗：无头探针遇到原生对话框会卡住 ✓
   */
  function channelOps(c, row) {
    const ops = el('div', 'flex items-center gap-1.5 justify-end flex-wrap');
    const mkBtn = (label, title, color) => {
      const b = el('button', 'text-[11px] px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors', label);
      if (title) b.title = title;
      if (color) b.style.color = color;
      return b;
    };
    const rebuild = () => { renderOpsInto(ops, c, row); };
    rebuild();
    return ops;
  }

  /** 画（或重画）操作区内容：默认三个按钮 ✓ */
  function renderOpsInto(ops, c, row) {
    ops.innerHTML = '';
    const mkBtn = (label, title, color) => {
      const b = el('button', 'text-[11px] px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors', label);
      if (title) b.title = title;
      if (color) b.style.color = color;
      return b;
    };

    // ── 改模型：行内表单（provider + model）──
    const editBtn = mkBtn('改模型', '临时切换该通道的提供商/模型（仅本进程有效，重启复原）');
    editBtn.onclick = () => {
      ops.innerHTML = '';
      const pIn = document.createElement('input');
      pIn.placeholder = 'provider';
      pIn.value = c.provider || '';
      pIn.className = 'w-24 text-[11px] px-2 py-1 rounded-md border border-border bg-background text-foreground';
      const mIn = document.createElement('input');
      mIn.placeholder = 'model';
      mIn.value = c.model || '';
      mIn.className = 'w-36 text-[11px] px-2 py-1 rounded-md border border-border bg-background text-foreground';
      const ok = mkBtn('确定');
      const cancel = mkBtn('取消');
      cancel.onclick = () => renderOpsInto(ops, c, row);
      ok.onclick = () => {
        if (!connected) { renderOpsInto(ops, c, row); return; }
        ok.disabled = true;
        client.request('model.setChannelModel', {
          name: c.name,
          provider: pIn.value.trim() || c.provider,
          model: mIn.value.trim() || undefined,
        })
          .then(() => { appendMsg('system', '通道 ' + c.name + ' 已切换模型'); loadModel(); })
          .catch((e) => { ok.disabled = false; appendMsg('error', '切换失败: ' + (e && e.message)); });
      };
      ops.appendChild(pIn); ops.appendChild(mIn); ops.appendChild(ok); ops.appendChild(cancel);
    };
    ops.appendChild(editBtn);

    // ── 复位：丢弃临时改动，回到持久化配置 ✓
    const rsBtn = mkBtn('复位', '撤销临时改动，恢复为配置文件里的设置');
    rsBtn.onclick = () => {
      if (!connected) return;
      rsBtn.disabled = true;
      client.request('model.resetChannelModel', { name: c.name })
        .then(() => { appendMsg('system', '通道 ' + c.name + ' 已复位'); loadModel(); })
        .catch((e) => { rsBtn.disabled = false; appendMsg('error', '复位失败: ' + (e && e.message)); });
    };
    ops.appendChild(rsBtn);

    // ── 删除：main 不可删（协议层也会拒 ✓，这里提前挡一道 ✓）──
    if (c.name === 'main') {
      ops.appendChild(el('span', 'text-[10px] text-muted-foreground', '主通道不可删'));
    } else {
      const rmBtn = mkBtn('删除', '从通道注册表移除该通道', 'var(--state-error)');
      rmBtn.onclick = () => {
        if (!connected) return;
        rmBtn.disabled = true;
        client.request('model.removeChannel', { name: c.name })
          .then(() => { appendMsg('system', '通道 ' + c.name + ' 已删除'); loadModel(); })
          .catch((e) => { rmBtn.disabled = false; appendMsg('error', '删除失败: ' + (e && e.message)); });
      };
      ops.appendChild(rmBtn);
    }
  }

  /**
   * 角色映射面板 —— 接 model.listRoles / setChannelRole ✓
   * 语义：哪个通道干哪件事（压缩 / 规划 / 子 Agent …）✓
   */
  async function buildRolesPanel(channels) {
    const wrap = el('div', 'px-4 py-3 border-t border-border');
    wrap.appendChild(el('div', 'text-xs font-semibold text-foreground mb-2', '角色映射（哪个通道干哪件事）'));
    let roles = {};
    try {
      const r = await client.request('model.listRoles');
      roles = (r && r.roles) || {};
    } catch (e) { /* 取不到就显示空态 ✓ */ }
    const names = Object.keys(roles);
    if (!names.length) {
      wrap.appendChild(el('div', 'text-xs text-muted-foreground', '（暂无角色映射信息）'));
      return wrap;
    }
    const grid = el('div', 'grid grid-cols-1 sm:grid-cols-2 gap-2');
    names.forEach((role) => {
      const line = el('div', 'flex items-center gap-2');
      line.appendChild(el('span', 'text-xs font-mono text-muted-foreground w-24 shrink-0', role));
      const sel = document.createElement('select');
      sel.className = 'flex-1 text-xs px-2 py-1 rounded-md border border-border bg-background text-foreground';
      const o0 = document.createElement('option');
      o0.value = 'main';
      o0.textContent = '（主通道）';
      sel.appendChild(o0);
      channels.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.name;
        o.textContent = c.name;
        sel.appendChild(o);
      });
      sel.value = roles[role] || 'main';
      sel.title = '把「' + role + '」这个角色交给哪个通道'+'';
      sel.onchange = () => {
        if (!connected) return;
        sel.disabled = true;
        client.request('model.setChannelRole', { role, channel: sel.value })
          .then(() => { appendMsg('system', '角色映射：' + role + ' → ' + sel.value); loadModel(); })
          .catch((e) => { sel.disabled = false; appendMsg('error', '设置失败: ' + (e && e.message)); });
      };
      line.appendChild(sel);
      grid.appendChild(line);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function renderChannels(channels) {
    const box = document.querySelector('[aria-labelledby="channels-heading"] .bg-card');
    if (!box) return;
    // 保留表头（第一个 channel-row bg-muted），清空其余（含静态演示行 + 注入的空 body）
    const header = box.querySelector('.channel-row.bg-muted');
    box.innerHTML = '';
    if (header) box.appendChild(header);
    if (!channels.length) {
      box.appendChild(el('div', 'channel-row px-4 py-3 text-sm text-muted-foreground', '暂无模型通道'));
      return;
    }
    channels.forEach((c) => {
      const row = el('div', 'channel-row px-4 py-3 border-b border-border text-sm');
      const nameCell = el('div');
      nameCell.appendChild(el('div', 'font-medium text-foreground', c.name || c.provider || '—'));
      if (c.model) nameCell.appendChild(el('div', 'text-xs text-muted-foreground font-mono', c.model));
      row.appendChild(nameCell);
      row.appendChild(el('div', 'channel-provider text-xs text-muted-foreground', c.provider || ''));
      const caps = el('div', 'flex flex-wrap gap-1.5');
      if (c.name === 'main') caps.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20', '主通道'));
      if (c.apiKeyEnv) caps.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border', c.apiKeyEnv));
      if (c.baseUrl) caps.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border', '自定义端点'));
      if (!c.name && !c.apiKeyEnv && !c.baseUrl) caps.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border', '—'));
      row.appendChild(caps);
      row.appendChild(channelOps(c, row));
      box.appendChild(row);
    });
    // 角色映射面板（异步取 roles ⇒ 取到再挂 ✓）
    buildRolesPanel(channels).then((panel) => { if (box.isConnected) box.appendChild(panel); }).catch(() => { /* ignore */ });
  }

  function renderLocalModels(models) {
    const list = $('#model-local-list');
    if (!list) return;
    list.innerHTML = '';
    if (!models.length) {
      list.appendChild(el('div', 'text-xs text-muted-foreground px-3 py-2', '未检测到本地模型（Ollama / llama.cpp）'));
      return;
    }
    models.forEach((m) => {
      const row = el('div', 'flex items-center justify-between text-xs px-3 py-2 rounded-md bg-muted border border-border');
      row.appendChild(el('span', 'font-mono text-foreground', m.name));
      const btn = el('button', 'text-primary hover:underline', m.enabled ? '运行中' : '启动');
      btn.onclick = () => {
        const provider = m.backend === 'ollama' ? 'ollama' : 'local';
        client.request('model.switch', { provider, model: m.name }).then(() => {
          loadModel();
          refreshState();
        }).catch((e) => appendMsg('error', `本地模型启动失败: ${e && e.message}`));
      };
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  // ── 添加密钥弹层（复用桌面视觉，接 model.upsertChannel）──
  let addKeyOverlay = null;

  function showAddKeyDialog(presetProvider) {
    if (!addKeyOverlay) {
      addKeyOverlay = document.createElement('div');
      addKeyOverlay.id = 'add-key-overlay';
      addKeyOverlay.style.cssText =
        'position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);';
      addKeyOverlay.innerHTML =
        '<div style="width:min(420px,92vw);background:var(--hyacinth-card);border:1px solid var(--hyacinth-border);' +
        'border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px;' +
        'box-shadow:0 24px 64px rgba(0,0,0,.4)">' +
        '  <div style="display:flex;align-items:center;justify-content:space-between">' +
        '    <h3 style="font-size:14px;font-weight:600;color:var(--hyacinth-foreground)">添加 API 密钥</h3>' +
        '    <button data-ac="close" style="background:none;border:none;color:var(--hyacinth-muted-foreground);cursor:pointer;padding:4px" aria-label="关闭"><i data-lucide="x" class="w-4 h-4"></i></button>' +
        '  </div>' +
        '  <label style="font-size:12px;color:var(--hyacinth-foreground)">提供商</label>' +
        '  <select data-ac="provider" style="height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--hyacinth-border);' +
        '    background:var(--hyacinth-input);color:var(--hyacinth-foreground);font-size:13px">' +
        '    <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option>' +
        '    <option value="google">Google</option><option value="mistral">Mistral</option>' +
        '    <option value="cohere">Cohere</option><option value="groq">Groq</option>' +
        '    <option value="deepseek">DeepSeek</option><option value="qwen">Qwen</option>' +
        '  </select>' +
        '  <label style="font-size:12px;color:var(--hyacinth-foreground)">API Key</label>' +
        '  <input data-ac="key" type="password" placeholder="sk-..." style="height:32px;padding:0 10px;border-radius:6px;' +
        '    border:1px solid var(--hyacinth-border);background:var(--hyacinth-input);color:var(--hyacinth-foreground);font-size:13px" />' +
        '  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:2px">' +
        '    <button data-ac="cancel" style="padding:7px 14px;border-radius:6px;border:1px solid var(--hyacinth-border);' +
        '      background:transparent;color:var(--hyacinth-foreground);font-size:12px;cursor:pointer">取消</button>' +
        '    <button data-ac="save" style="padding:7px 14px;border-radius:6px;border:none;' +
        '      background:var(--hyacinth-primary);color:var(--hyacinth-primary-foreground);font-size:12px;cursor:pointer">保存</button>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(addKeyOverlay);
      const close = () => { addKeyOverlay.style.display = 'none'; };
      addKeyOverlay.addEventListener('click', (e) => { if (e.target === addKeyOverlay) close(); });
      addKeyOverlay.querySelector('[data-ac="close"]').addEventListener('click', close);
      addKeyOverlay.querySelector('[data-ac="cancel"]').addEventListener('click', close);
      addKeyOverlay.querySelector('[data-ac="save"]').addEventListener('click', () => {
        const provider = addKeyOverlay.querySelector('[data-ac="provider"]').value;
        const apiKey = addKeyOverlay.querySelector('[data-ac="key"]').value.trim();
        if (!apiKey) return;
        close();
        client.request('model.upsertChannel', { name: provider, provider, apiKey }).then(() => {
          loadModel();
          appendMsg('system', `已保存 ${provider} API 密钥`);
        }).catch((e) => appendMsg('error', `保存失败: ${e && e.message}`));
      });
    }
    // 预选 provider（来自「配置密钥」按钮）
    if (presetProvider) {
      const sel = addKeyOverlay.querySelector('[data-ac="provider"]');
      if (sel && Array.from(sel.options).some((o) => o.value === presetProvider)) {
        sel.value = presetProvider;
      }
    }
    addKeyOverlay.style.display = 'flex';
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  function bindModelView() {
    // 推理强度 radio → setThinking + 描述联动
    const descEl = $('#model-reasoning-desc');
    $$('input[name="reasoning"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        if (descEl && REASONING_DESC[r.value]) descEl.textContent = REASONING_DESC[r.value];
        const enabled = r.value !== 'low';
        client.request('model.setThinking', { enabled, effort: r.value }).catch(() => {});
      });
    });
    // 添加密钥按钮
    const addKeyBtn = $('#model-add-key-btn');
    if (addKeyBtn) addKeyBtn.onclick = () => showAddKeyDialog();
    // Ollama 刷新按钮 → 旋转动画 + 重新拉本地模型
    const refreshBtn = $('#model-refresh-btn');
    if (refreshBtn) {
      refreshBtn.onclick = () => {
        const icon = refreshBtn.querySelector('svg, i');
        if (icon) { icon.style.transition = 'transform 600ms ease'; icon.style.transform = 'rotate(360deg)'; }
        setTimeout(() => { if (icon) icon.style.transform = ''; }, 650);
        client.request('model.listLocalModels').then((res) => renderLocalModels((res && res.models) || []))
          .catch(() => {});
      };
    }
    // Ollama 地址输入框 → change 时持久化到配置（model.setLocalConfig）
    const ollamaUrlInput = $('#model-ollama-url');
    if (ollamaUrlInput) {
      ollamaUrlInput.addEventListener('change', () => {
        const ollamaUrl = ollamaUrlInput.value.trim();
        if (!ollamaUrl) return;
        client.request('model.setLocalConfig', { ollamaUrl })
          .then(() => { appendMsg('system', `Ollama 地址已更新: ${ollamaUrl}`); })
          .catch((e) => appendMsg('error', `Ollama 地址保存失败: ${e && e.message}`));
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // 聊天发送
  // ════════════════════════════════════════════════════════════
  function sendChat() {
    const input = $('#chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    appendMsg('user', text);
    input.value = '';
    if (!connected) {
      appendMsg('error', '尚未连接后端，无法发送');
      return;
    }
    setBusy(true);
    client.request('message.chat', { content: text }).catch((e) => {
      setBusy(false);
      appendMsg('error', `发送失败: ${(e && e.message) || '未知错误'}`);
    });
  }

  // ════════════════════════════════════════════════════════════
  // 会话视图（session 域：list / resume / create / delete / batchDelete / export）
  // ════════════════════════════════════════════════════════════
  let sessionsCache = [];
  /** 批量操作：当前勾选的 sessionId 集合 */
  const sessionSelection = new Set();

  function fmtSessionTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return iso; }
  }

  function sessionTypeLabel(t) {
    if (t === 'precise') return 'Precise';
    if (t === 'companion') return 'Companion';
    return 'Chat';
  }

  function renderSessions() {
    const tbody = $('#sessions-tbody');
    const countEl = $('#sessions-count');
    if (!tbody) return;
    const q = (($('#sessions-search') && $('#sessions-search').value) || '').trim().toLowerCase();
    const type = ($('#sessions-type') && $('#sessions-type').value) || '';
    const sortMode = ($('#sessions-sort') && $('#sessions-sort').value) || 'updated-desc';
    let rows = sessionsCache.filter((s) => {
      if (type && (s.type || 'normal') !== type) return false;
      if (q && !(s.id || '').toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => {
      if (sortMode === 'name-asc') return (a.id || '').localeCompare(b.id || '');
      if (sortMode === 'created-desc') return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    tbody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'px-4 py-6 text-center text-xs text-muted-foreground';
      td.textContent = '暂无会话';
      tr.appendChild(td);
      tbody.appendChild(tr);
      if (countEl) countEl.textContent = '0';
      updateBatchUI();
      return;
    }
    rows.forEach((s) => {
      const isCurrent = s.id === currentSessionId;
      const tr = document.createElement('tr');
      tr.className = 'group hover:bg-muted/50 transition-colors' + (isCurrent ? ' bg-primary/5' : '');
      tr.dataset.sessionId = s.id;
      // 0) 勾选（批量操作）
      const tdCheck = document.createElement('td');
      tdCheck.className = 'px-4 py-3 align-middle';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'session-check w-3.5 h-3.5 rounded cursor-pointer accent-[var(--hyacinth-primary)]';
      check.dataset.sid = s.id;
      check.checked = sessionSelection.has(s.id);
      tdCheck.appendChild(check);
      // 1) 当前标记
      const tdCur = document.createElement('td');
      tdCur.className = 'px-4 py-3 align-middle';
      if (isCurrent) tdCur.innerHTML = '<span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary" title="当前会话"><i data-lucide="check" class="w-3 h-3"></i></span>';
      // 2) 会话 ID
      const tdId = document.createElement('td');
      tdId.className = 'px-4 py-3 align-middle';
      const idSpan = document.createElement('span');
      idSpan.className = 'font-mono text-xs text-foreground';
      idSpan.textContent = s.id;
      tdId.appendChild(idSpan);
      // 3) 名称（协议层无 name 字段 → 显示 id）
      const tdName = document.createElement('td');
      tdName.className = 'px-4 py-3 align-middle';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'text-sm font-medium text-foreground';
      nameSpan.textContent = s.id;
      tdName.appendChild(nameSpan);
      // 4) 类型
      const tdType = document.createElement('td');
      tdType.className = 'px-4 py-3 align-middle';
      const typeBadge = document.createElement('span');
      typeBadge.className = 'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ' + (s.type === 'precise' ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary');
      typeBadge.textContent = sessionTypeLabel(s.type);
      tdType.appendChild(typeBadge);
      // 5) 创建时间
      const tdCreated = document.createElement('td');
      tdCreated.className = 'px-4 py-3 align-middle';
      tdCreated.innerHTML = '<span class="text-xs text-muted-foreground font-mono">' + esc(fmtSessionTime(s.createdAt)) + '</span>';
      // 6) 更新时间
      const tdUpdated = document.createElement('td');
      tdUpdated.className = 'px-4 py-3 align-middle';
      tdUpdated.innerHTML = '<span class="text-xs text-muted-foreground font-mono">' + esc(fmtSessionTime(s.updatedAt)) + '</span>';
      // 7) 操作（加载 / 删除）
      const tdOps = document.createElement('td');
      tdOps.className = 'px-4 py-3 align-middle';
      const opsDiv = document.createElement('div');
      opsDiv.className = 'flex items-center justify-end gap-2';
      const loadBtn = document.createElement('button');
      loadBtn.className = 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs text-foreground hover:bg-muted transition-colors';
      loadBtn.setAttribute('aria-label', 'Load session');
      loadBtn.dataset.action = 'load';
      loadBtn.innerHTML = '<i data-lucide="download" class="w-3.5 h-3.5"></i><span>加载</span>';
      const delBtn = document.createElement('button');
      delBtn.className = 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs hover:bg-muted transition-colors';
      delBtn.style.color = 'var(--state-error)';
      delBtn.setAttribute('aria-label', 'Delete session');
      delBtn.dataset.action = 'delete';
      delBtn.innerHTML = '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i><span>删除</span>';
      opsDiv.appendChild(loadBtn);
      opsDiv.appendChild(delBtn);
      tdOps.appendChild(opsDiv);
      tr.appendChild(tdCheck); tr.appendChild(tdCur); tr.appendChild(tdId); tr.appendChild(tdName); tr.appendChild(tdType);
      tr.appendChild(tdCreated); tr.appendChild(tdUpdated); tr.appendChild(tdOps);
      tbody.appendChild(tr);
    });
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    if (countEl) countEl.textContent = String(rows.length);
    syncSelectAllState();
    updateBatchUI();
  }

  // ── 批量操作辅助 ─────────────────────────────────────────
  /** 同步表头全选框状态（全选/半选/未选） */
  function syncSelectAllState() {
    const all = $('#sessions-select-all');
    if (!all) return;
    const boxes = Array.from(document.querySelectorAll('#sessions-tbody .session-check'));
    if (!boxes.length) { all.checked = false; all.indeterminate = false; return; }
    const checkedCount = boxes.filter((b) => b.checked).length;
    all.checked = checkedCount === boxes.length;
    all.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  }

  /** 根据勾选数量刷新批量按钮与计数 */
  function updateBatchUI() {
    const delBtn = $('#sessions-batch-delete');
    const expBtn = $('#sessions-export-btn');
    const cnt = $('#sessions-selected-count');
    const n = sessionSelection.size;
    if (delBtn) delBtn.disabled = n === 0;
    if (expBtn) expBtn.disabled = n === 0;
    if (cnt) {
      cnt.classList.toggle('hidden', n === 0);
      const b = cnt.querySelector('b');
      if (b) b.textContent = String(n);
    }
  }

  /** base64 → 浏览器下载 */
  function downloadZip(b64, filename) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      appendMsg('error', '导出下载失败: ' + ((e && e.message) || String(e)));
    }
  }

  async function loadSessions() {
    if (!connected) return;
    try {
      const res = await client.request('session.list');
      sessionsCache = (res && res.sessions) || [];
      // 勾选集合与真实数据同步（删除/刷新后清理失效 id）
      const alive = new Set(sessionsCache.map((s) => s.id));
      for (const id of [...sessionSelection]) {
        if (!alive.has(id)) sessionSelection.delete(id);
      }
      renderSessions();
    } catch (e) { /* ignore */ }
  }

  function bindSessionsView() {
    const search = $('#sessions-search');
    const type = $('#sessions-type');
    const sort = $('#sessions-sort');
    const createBtn = $('#sessions-create-btn');
    if (search) search.addEventListener('input', renderSessions);
    if (sort) sort.addEventListener('change', renderSessions);
    // 类型筛选：重建选项为协议层真实类型（骨架默认 chat/completion/agent 与协议层 normal/precise/companion 不匹配）
    if (type) {
      const TYPES = [
        { v: '', label: '全部类型' },
        { v: 'normal', label: 'Chat' },
        { v: 'precise', label: 'Precise' },
        { v: 'companion', label: 'Companion' },
      ];
      type.innerHTML = '';
      TYPES.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.v;
        opt.textContent = t.label;
        type.appendChild(opt);
      });
      type.addEventListener('change', renderSessions);
    }
    // 新建按钮 → session.create + session.switch（创建后切到新会话，loop 真正指向新目录）
    if (createBtn) {
      createBtn.onclick = () => {
        if (!connected) return;
        client.request('session.create', { type: 'normal' }).then((meta) => {
          const sid = (meta && meta.id) || null;
          if (!sid) return;
          return client.request('session.switch', { sessionId: sid }).then(() => {
            currentSessionId = sid;
            loadSessions();
            clearChat();
            appendMsg('system', '新会话已创建');
          });
        }).catch((e) => appendMsg('error', '创建会话失败: ' + (e && e.message)));
      };
    }
    // 导入按钮 → 占位提示
    const importBtn = $('#sessions-import-btn');
    if (importBtn) importBtn.onclick = () => appendMsg('system', '导入功能将在后续版本支持');
    // tbody 事件委托：加载 / 删除
    const tbody = $('#sessions-tbody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        const tr = e.target.closest('tr[data-session-id]');
        if (!btn || !tr) return;
        const sid = tr.dataset.sessionId;
        const action = btn.dataset.action;
        if (action === 'load') {
          if (!connected) return;
          // 加载会话 = 切换后端 loop 当前会话目录（session.switch），
          // 而非仅读元数据（session.resume 不切换 loop，会导致后续消息写错会话）
          client.request('session.switch', { sessionId: sid }).then(() => {
            currentSessionId = sid;
            appendMsg('system', '已加载会话 ' + sid);
            goTo('#/chat');
            loadHistory();
          }).catch((e2) => appendMsg('error', '加载会话失败: ' + (e2 && e2.message)));
        } else if (action === 'delete') {
          if (!connected) return;
          client.request('session.delete', { sessionId: sid }).then(() => {
            appendMsg('system', '已删除会话 ' + sid);
            sessionSelection.delete(sid);
            loadSessions();
          }).catch((e2) => appendMsg('error', '删除会话失败: ' + (e2 && e2.message)));
        }
      });
      // 行勾选框（change 事件委托）
      tbody.addEventListener('change', (e) => {
        const box = e.target.closest('.session-check');
        if (!box || !box.dataset.sid) return;
        if (box.checked) sessionSelection.add(box.dataset.sid);
        else sessionSelection.delete(box.dataset.sid);
        syncSelectAllState();
        updateBatchUI();
      });
    }
    // 表头全选框
    const selectAll = $('#sessions-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        const boxes = Array.from(document.querySelectorAll('#sessions-tbody .session-check'));
        boxes.forEach((b) => {
          b.checked = selectAll.checked;
          if (selectAll.checked) sessionSelection.add(b.dataset.sid);
          else sessionSelection.delete(b.dataset.sid);
        });
        updateBatchUI();
      });
    }
    // 批量删除
    const batchDeleteBtn = $('#sessions-batch-delete');
    if (batchDeleteBtn) {
      batchDeleteBtn.onclick = () => {
        if (!connected || sessionSelection.size === 0) return;
        const ids = [...sessionSelection];
        if (!window.confirm(`确定删除选中的 ${ids.length} 个会话？此操作不可恢复。`)) return;
        client.request('session.batchDelete', { sessionIds: ids }).then((res) => {
          const deleted = (res && res.deleted) || [];
          const notFound = (res && res.notFound) || [];
          sessionSelection.clear();
          appendMsg('system', `已批量删除 ${deleted.length} 个会话` + (notFound.length ? `（${notFound.length} 个不存在）` : ''));
          loadSessions();
        }).catch((e2) => appendMsg('error', '批量删除失败: ' + (e2 && e2.message)));
      };
    }
    // 批量导出（zip）
    const exportBtn = $('#sessions-export-btn');
    if (exportBtn) {
      exportBtn.onclick = () => {
        if (!connected || sessionSelection.size === 0) return;
        const ids = [...sessionSelection];
        exportBtn.disabled = true;
        appendMsg('system', `正在导出 ${ids.length} 个会话…`);
        client.request('session.export', { sessionIds: ids }).then((res) => {
          if (!res || !res.data) throw new Error('空响应');
          downloadZip(res.data, res.filename || 'hyacinth-sessions.zip');
          appendMsg('system', `已导出 ${res.count || ids.length} 个文件 → ${res.filename || 'hyacinth-sessions.zip'}`);
        }).catch((e2) => appendMsg('error', '导出失败: ' + (e2 && e2.message)))
          .finally(() => { exportBtn.disabled = sessionSelection.size === 0; });
      };
    }
  }

  // ════════════════════════════════════════════════════════════
  // 设置视图（config 域：getAll / set / reset）
  // ════════════════════════════════════════════════════════════
  // data-dom-id → [config 路径, 类型]（路径必须存在于 config schema，否则 set 会 throw）
  const SETTINGS_MAP = [
    // 上下文 tab（zone1/2/3/5 开关不走 config —— 真源是 .agent/context-manifest.json，
    // 见 bindManifestZoneToggles；此处仅 zone4 检索预算开关仍属配置键）
    ['toggle-zone4', 'kb.zone4', 'bool'],
    ['select-default-context-mode', 'startup.defaultMode', 'str'],
    ['select-companion-character', 'companion.defaultCharacter', 'str'],
    ['toggle-intent-block', 'context.intentBlock', 'bool'],
    ['toggle-bypass-agents', 'bypass.orchestratorEnabled', 'bool'],
    ['toggle-long-term-memory', 'context.longTermMemory', 'bool'],
    ['input-max-context', 'session.maxContext', 'num'],
    ['input-max-messages', 'session.maxMessages', 'num'],
    ['input-kb-max-total', 'kb.maxTotal', 'num'],
    ['input-kb-max-main', 'kb.maxMain', 'num'],
    ['input-kb-max-refs', 'kb.maxRefs', 'num'],
    ['toggle-watch-prompts', 'hotReload.watchPrompts', 'bool'],
    // 轮次 tab
    ['input-max-turns', 'session.maxTurns', 'num'],
    ['input-max-messages-turns', 'session.maxMessages', 'num'],
    ['input-response-timeout', 'session.responseTimeoutSec', 'num'],    ['toggle-collapse-tools', 'tools.collapseTools', 'bool'],
    ['toggle-reasoning-tokens', 'provider.showThinking', 'bool'],
    ['select-continuity', 'context.continuity', 'str'],
    // 压缩 tab
    ['input-compress-threshold', 'context.compressThreshold', 'num'],
    ['input-emergency-threshold', 'context.emergencyThreshold', 'num'],
    ['input-compress-depth', 'context.compressDepth', 'num'],
    ['input-max-compress-rounds', 'context.maxCompressRounds', 'num'],
    ['input-trim-window', 'context.trimWindow', 'num'],
    // 模式 tab
    ['select-default-mode', 'provider.defaultMode', 'str'],
    ['input-temperature', 'provider.temperature', 'num'],
    ['input-top-p', 'provider.topP', 'num'],
    ['input-frequency-penalty', 'provider.frequencyPenalty', 'num'],
    ['input-presence-penalty', 'provider.presencePenalty', 'num'],
    ['toggle-streaming', 'provider.streaming', 'bool'],
    ['toggle-json-mode', 'provider.jsonMode', 'bool'],
    ['toggle-tool-use', 'tools.toolUse', 'bool'],
    ['toggle-auto-model', 'provider.autoModel', 'bool'],
    // 修复 tab
    ['toggle-auto-retry', 'resiliency.retry.enabled', 'bool'],
    ['input-max-retries', 'resiliency.retry.maxRetries', 'num'],
    ['select-fallback-model', 'provider.fallbackModel', 'str'],
    ['toggle-sanitize', 'tools.sanitize', 'bool'],
    ['toggle-repair-log', 'logging.repairLog', 'bool'],
  ];

  // Zone 开关（zone1/2/3/5）：真源是 .agent/context-manifest.json 的 zone.enabled
  // （context.manifest / context.setZoneEnabled 协议方法；manifest-watcher 热重载），
  // 不走 config —— 旧 context.zones 键已废弃（schema 标注 @deprecated）。
  // zone4 检索预算开关仍走 kb.zone4（SETTINGS_MAP，语义是"是否启用检索"而非 zone 整体）。
  const MANIFEST_ZONE_TOGGLES = ['toggle-zone1', 'toggle-zone2', 'toggle-zone3', 'toggle-zone5'];

  // 初始化：读 manifest 回填开关状态（读取失败保留控件现状）
  async function loadManifestZoneToggles() {
    if (!connected) return;
    try {
      const res = await client.request('context.manifest');
      if (!res || !Array.isArray(res.zones)) return;
      const byName = {};
      res.zones.forEach((z) => { byName[z.name] = z; });
      MANIFEST_ZONE_TOGGLES.forEach((domId) => {
        const el = $('[data-dom-id="' + domId + '"]');
        if (!el) return;
        const zoneName = domId.replace('toggle-', '');
        const z = byName[zoneName];
        if (z && typeof z.enabled === 'boolean') el.checked = z.enabled;
      });
    } catch (e) { /* manifest 读取失败保留控件现状 */ }
  }

  // 绑定：change → context.setZoneEnabled（失败回滚开关）
  function bindManifestZoneToggles() {
    MANIFEST_ZONE_TOGGLES.forEach((domId) => {
      const el = $('[data-dom-id="' + domId + '"]');
      if (!el) return;
      el.addEventListener('change', () => {
        if (!connected) return;
        const zoneName = domId.replace('toggle-', '');
        client.request('context.setZoneEnabled', { zone: zoneName, enabled: el.checked })
          .then(() => appendMsg('system', `Zone ${zoneName} 已${el.checked ? '启用' : '停用'}`))
          .catch((e) => {
            appendMsg('error', `设置 Zone ${zoneName} 失败: ${((e && e.message) || '未知错误')}`);
            el.checked = !el.checked; // 失败回滚
          });
      });
    });
  }

  function getByPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  // 回填单个控件（loadSettings 用）
  function applySettingValue(domId, path, type, cfg) {
    const el = $('[data-dom-id="' + domId + '"]');
    if (!el) return;
    const val = getByPath(cfg, path);
    if (val === undefined) return;
    if (type === 'bool') {
      el.checked = !!val;
    } else if (type === 'num') {
      el.value = String(val);
      if (el.type === 'range' && el.nextElementSibling) {
        el.nextElementSibling.textContent = Number(val).toFixed(1);
      }
    } else {
      const sv = String(val);
      if (el.tagName === 'SELECT') {
        let ok = false;
        for (const opt of el.options) { if (opt.value === sv) { ok = true; break; } }
        if (!ok) {
          const opt = document.createElement('option');
          opt.value = sv; opt.textContent = sv;
          el.appendChild(opt);
        }
        el.value = sv;
      } else {
        el.value = sv;
      }
    }
  }

  // 读真实配置 → 回填全部控件
  function loadSettings() {
    if (!connected) return;
    client.request('config.getAll').then(async (cfg) => {
      if (!cfg) return;
      SETTINGS_MAP.forEach(([domId, path, type]) => applySettingValue(domId, path, type, cfg));
      // Zone 开关（zone1/2/3/5）：manifest 真源（.agent/context-manifest.json）
      loadManifestZoneToggles().catch(() => {});
      // 陪伴角色下拉：选项来自协议层 companion.get（自动检测人格目录，无硬编码）
      try {
        const cstate = await client.request('companion.get');
        const sel = $('#select-companion-character');
        if (sel && cstate && Array.isArray(cstate.characters)) {
          const current = getByPath(cfg, 'companion.defaultCharacter') || '';
          sel.innerHTML = '<option value="">自动（跟随上次）</option>' +
            cstate.characters.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
          sel.value = current;
        }
      } catch (e) { /* 角色列表拉取失败保留下拉默认项 */ }
      // 陪伴音色下拉：选项来自协议层 companion.voices（音色库），选中当前角色绑定的音色
      try {
        const vs = await client.request('companion.voices');
        const vsel = $('#select-companion-voice');
        if (vsel && vs && Array.isArray(vs.voices)) {
          const boundVoice = vs.voices.find((v) => v.bind === companionDefaultCharacter);
          vsel.innerHTML = '<option value="">未绑定（用 config 音色）</option>' +
            vs.voices.map((v) => `<option value="${esc(v.id)}">${esc(v.id)}${v.bind ? '（绑定:' + esc(v.bind) + '）' : ''}</option>`).join('');
          vsel.value = boundVoice ? boundVoice.id : '';
        }
      } catch (e) { /* 音色列表拉取失败保留下拉默认项 */ }
      companionDefaultCharacter = getByPath(cfg, 'companion.defaultCharacter') || '';
      // 主题：ui.theme（用户偏好，存全局配置）
      const theme = getByPath(cfg, 'ui.theme');
      if (typeof theme === 'string' && theme) applyTheme(theme);
    }).catch((e) => appendMsg('error', '读取配置失败: ' + ((e && e.message) || '未知错误')));
  }

  // ════════════════════════════════════════════════════════════
  // 主题（Theme）
  // ────────────────────────────────────────────────────────────
  // 主题由 theme.css 的 html[data-theme="x"] 定义（只覆盖调色板变量），
  // 这里负责：卡片渲染 / 应用 / 持久化到后端 ui.theme。
  // ════════════════════════════════════════════════════════════

  const THEMES = [
    { id: 'hyacinth', name: '夜园', desc: '夜花园 · 萤光花穗',
      swatches: ['#0f1120', '#161930', '#a78bfa', '#2dd4bf', '#eceefa'] },
    { id: 'light', name: '昼园', desc: '水彩花园 · 清晨',
      swatches: ['#f6f8f3', '#fdfefc', '#c9baf6', '#43a461', '#1a2016'] },
    { id: 'dark', name: '深夜', desc: '纯净极简 · 无装饰',
      swatches: ['#0d0d10', '#131318', '#2a2a33', '#8f8fd6', '#eeeef1'] },
    { id: 'glass', name: '琉璃', desc: '晨雾花园 · 毛玻璃',
      swatches: ['#c9baf6', '#a4d9b1', '#ffffff', '#6d4ac4', '#2b8a4c'] },
    { id: 'ink', name: '墨韵', desc: '水墨衬线 · 朱砂',
      swatches: ['#171716', '#1d1d1b', '#f0eee4', '#d65a40', '#c9a83c'] },
    { id: 'rainy', name: '雨夜', desc: '书房灯影 · 雨声',
      swatches: ['#0e1420', '#141b28', '#f6c453', '#3fb0b3', '#ecf0f5'] },
  ];

  const THEME_IDS = THEMES.map((t) => t.id);
  let currentTheme = 'hyacinth';

  // ── 用户自备背景图（assets/bg/<主题id>.webp|jpg|png）─────────────
  // 文件存在 → 设为该主题的最上层背景（主题遮罩自动压暗保文字可读）；
  // 不存在 → 回落到主题自带背景画。探测结果按主题缓存。
  const userBgCache = {};

  function applyUserBg(file) {
    if (file) document.documentElement.style.setProperty('--hyacinth-user-bg', `url("${file}")`);
    else document.documentElement.style.removeProperty('--hyacinth-user-bg');
  }

  function probeUserBg(id) {
    if (id in userBgCache) { applyUserBg(userBgCache[id]); return; }
    const exts = ['webp', 'jpg', 'png'];
    let i = 0;
    const tryNext = () => {
      if (i >= exts.length) { userBgCache[id] = null; applyUserBg(null); return; }
      const file = `assets/bg/${id}.${exts[i++]}`;
      const img = new Image();
      img.onload = () => { userBgCache[id] = file; if (currentTheme === id) applyUserBg(file); };
      img.onerror = () => tryNext();
      img.src = file;
    };
    tryNext();
  }

  /** 应用主题：设置 <html data-theme>，并同步选中态 */
  function applyTheme(name) {
    const id = THEME_IDS.indexOf(name) >= 0 ? name : 'hyacinth';
    currentTheme = id;
    document.documentElement.setAttribute('data-theme', id);
    // 本地缓存：下次加载立即应用，避免等待后端连接造成闪烁
    try { localStorage.setItem('hyacinth.theme', id); } catch (e) { /* 隐私模式忽略 */ }
    probeUserBg(id);
    // 同步卡片选中态
    const grid = $('#theme-grid');
    if (grid) {
      grid.querySelectorAll('.theme-card').forEach((card) => {
        card.setAttribute('aria-pressed', card.dataset.theme === id ? 'true' : 'false');
      });
    }
  }

  /** 启动时先用本地缓存主题（避免闪烁），连上后端后再以 ui.theme 为准 */
  function initThemeFromCache() {
    let cached = null;
    try { cached = localStorage.getItem('hyacinth.theme'); } catch (e) { /* ignore */ }
    if (cached && THEME_IDS.indexOf(cached) >= 0) applyTheme(cached);
    else applyTheme('hyacinth');
  }

  /** 渲染主题卡片网格 */
  function renderThemes() {
    const grid = $('#theme-grid');
    if (!grid || grid.dataset.rendered === '1') return;
    grid.dataset.rendered = '1';
    THEMES.forEach((t) => {
      const card = el('button', 'theme-card');
      card.type = 'button';
      card.dataset.theme = t.id;
      card.setAttribute('aria-pressed', t.id === currentTheme ? 'true' : 'false');
      card.title = `${t.name}（${t.desc}）`;

      const preview = el('div', 'theme-preview');
      t.swatches.forEach((c) => {
        const sw = el('span', 'theme-preview-swatch');
        sw.style.backgroundColor = c;
        preview.appendChild(sw);
      });
      card.appendChild(preview);

      const meta = el('div', 'theme-meta');
      meta.appendChild(el('span', 'theme-name', t.name));
      meta.appendChild(el('span', 'theme-check', '✓ 当前'));
      card.appendChild(meta);
      meta.insertBefore(el('span', 'settings-desc', t.desc), meta.lastChild);

      card.onclick = () => {
        applyTheme(t.id);
        // 持久化到后端（ui.theme 存全局配置，切项目不丢）
        if (connected) {
          client.request('config.set', { path: 'ui.theme', value: t.id }).catch((e) => {
            appendMsg('error', '保存主题失败: ' + ((e && e.message) || '未知错误'));
          });
        }
      };
      grid.appendChild(card);
    });
  }

  // 绑定设置视图交互：控件 change → config.set；重置按钮 → config.reset
  function bindSettingsView() {
    // 默认模式：修改时同步本地缓存（下次启动直接进入对应模式，无闪屏）
    const modeSel = $('[data-dom-id="select-default-context-mode"]');
    if (modeSel) {
      modeSel.addEventListener('change', () => {
        try { localStorage.setItem('hyacinth.startupMode', modeSel.value || 'normal'); } catch (e) { /* ignore */ }
      });
    }
    // 陪伴音色：换选 → 绑定为默认陪伴角色的音色（协议 companion.voiceBind）
    const voiceSel = $('[data-dom-id="select-companion-voice"]');
    if (voiceSel) {
      voiceSel.addEventListener('change', () => {
        const voiceId = voiceSel.value || '';
        const character = companionDefaultCharacter || companionCharacter;
        if (!connected || !voiceId || !character) return;
        client.request('companion.voiceBind', { voiceId, character }).then(() => {
          appendMsg('system', `音色 ${voiceId} 已绑定为 ${character} 的默认音色`);
        }).catch((e) => {
          appendMsg('error', '音色绑定失败: ' + ((e && e.message) || '未知错误'));
        });
      });
    }
    // 陪伴角色：保存配置（SETTINGS_MAP 通用绑定）之外，陪伴中换选 → 立即切换角色
    const charSel = $('[data-dom-id="select-companion-character"]');
    if (charSel) {
      charSel.addEventListener('change', () => {
        const value = charSel.value || '';
        companionDefaultCharacter = value;
        if (!connected || !companionActive || !value) return;
        client.request('companion.activate', { character: value }).then((res) => {
          companionCharacter = (res && res.character) || value;
          appendMsg('system', `已切换陪伴角色: ${companionCharacter}`);
        }).catch((e) => {
          appendMsg('error', '切换陪伴角色失败: ' + ((e && e.message) || '未知错误'));
        });
      });
    }
    SETTINGS_MAP.forEach(([domId, path, type]) => {
      const el = $('[data-dom-id="' + domId + '"]');
      if (!el) return;
      const save = () => {
        if (!connected) return;
        let value;
        if (type === 'bool') value = el.checked;
        else if (type === 'num') value = parseFloat(el.value);
        else value = el.value;
        client.request('config.set', { path, value }).catch((e) => {
          appendMsg('error', `保存 ${path} 失败: ${((e && e.message) || '未知错误')}`);
        });
      };
      if (el.type === 'checkbox') {
        el.addEventListener('change', save);
      } else if (el.type === 'range') {
        el.addEventListener('change', save);
        el.addEventListener('input', () => {
          if (el.nextElementSibling) el.nextElementSibling.textContent = Number(el.value).toFixed(1);
        });
      } else {
        el.addEventListener('change', save);
      }
    });
    // Zone 开关（zone1/2/3/5）：manifest 真源（context.setZoneEnabled）
    bindManifestZoneToggles();
    // 重置按钮 → config.reset（全部恢复默认）
    const resetBtn = $('[data-dom-id="btn-reset-defaults"]');
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (!connected) return;
        client.request('config.reset').then(() => {
          appendMsg('system', '已恢复默认配置');
          loadSettings();
        }).catch((e) => appendMsg('error', '重置失败: ' + ((e && e.message) || '未知错误')));
      };
    }
    // Zone 1 组装预览 → context.previewZone（显示真实组装内容）
    const previewBtn = $('#btn-context-preview');
    const previewArea = $('#textarea-system-prompt-preview');
    if (previewBtn && previewArea) {
      previewBtn.onclick = () => {
        if (!connected) return;
        previewBtn.disabled = true;
        previewArea.value = '正在组装 Zone 1…';
        client.request('context.previewZone', { zone: 'zone1' }).then((res) => {
          if (res && res.text) {
            previewArea.value = res.text;
            appendMsg('system', `Zone 1 预览已刷新（${res.tokens || 0} tokens）`);
          } else {
            previewArea.value = '（Zone 1 当前未启用或为空）';
          }
        }).catch((e) => {
          previewArea.value = '获取失败: ' + ((e && e.message) || String(e));
        }).finally(() => { previewBtn.disabled = false; });
      };
    }
  }

  // ════════════════════════════════════════════════════════════
  // 陪伴视图（companion 全屏沉浸式场景：场景轮播/对话框/历史浮层）
  // ════════════════════════════════════════════════════════════
  // 当前陪伴会话（进入时创建 type=companion 的会话）
  let companionSessionId = null;
  let companionActive = false;      // 后端 Router 是否在 companion 模式
  let companionCharacter = '';       // 当前角色名
  let companionDefaultCharacter = ''; // 设置里选的默认陪伴角色（''=自动跟随上次）
  let companionSceneIdx = 0;
  let companionSceneTimer = null;
  let companionInfoTimer = null;
  let companionSceneActive = null;
  // 真实场景（协议层 companion.scene 数据源）：live 单图驻留，替代 demo 轮播。
  // 轮询检测 signature/createdAt 变化 → 淡入切换；无场景时回落 demo 序列。
  let companionLiveScene = null;       // 当前真实场景 { signature, imageUrl, ... }
  let companionLiveSceneSig = '';      // 上次渲染的签名（变化才重绘）
  let companionScenePollTimer = null;  // 场景轮询定时器（15s）

  // demo 场景序列（无真实场景时的兜底氛围；有 scene.png 时切为 live 单图）
  const COMPANION_SCENES = [
    { type: 'image', src: 'assets/rainy-study.svg',  title: '雨夜书房', meta: '小雨 · 窗边一盏灯', holdMs: 9000 },
    { type: 'image', src: 'assets/concept-art.svg',  title: '概念场景', meta: '暮色 · 暖光', holdMs: 9000 },
    { type: 'video', src: '', poster: 'assets/video-poster.svg', title: '动态场景', meta: '示例视频 · 循环', holdMs: 8000 },
    { type: 'image', src: 'assets/rainy-study.svg',  title: '雨夜书房', meta: '雨声渐密 · 炉火', holdMs: 9000 },
  ];

  function companionBuildMedia(scene) {
    const holder = document.createElement('div');
    if (scene.type === 'video') {
      const v = document.createElement('video');
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.loop = !scene.holdMs;
      if (scene.poster) v.poster = scene.poster;
      if (scene.src) {
        const s = document.createElement('source');
        s.src = scene.src;
        s.type = 'video/mp4';
        v.appendChild(s);
      }
      if (!scene.src) v.style.background = 'var(--neutral-0)';
      holder.appendChild(v);
      return { el: holder, media: v };
    }
    const img = document.createElement('img');
    img.src = scene.src;
    img.alt = scene.title || '';
    holder.appendChild(img);
    return { el: holder, media: img };
  }

  function companionShowInfo(scene) {
    const title = $('#scene-info-title');
    const meta = $('#scene-info-meta');
    if (title) title.textContent = scene.title || '';
    if (meta) meta.textContent = scene.meta || '';
  }

  function companionRevealInfo() {
    const info = $('#scene-info');
    if (!info) return;
    info.classList.add('visible');
    clearTimeout(companionInfoTimer);
    companionInfoTimer = setTimeout(() => info.classList.remove('visible'), 3500);
  }

  function companionScheduleNext(scene, media) {
    clearTimeout(companionSceneTimer);
    // 真实场景（live）：驻留当前画面，不自动轮播 —— 等轮询检测到变化再切
    if (scene.live) return;
    if (scene.type === 'video' && media && typeof media.addEventListener === 'function' && scene.src) {
      media.addEventListener('ended', () => setTimeout(companionNextScene, 700), { once: true });
      return;
    }
    companionSceneTimer = setTimeout(companionNextScene, scene.holdMs || 8000);
  }

  function companionRenderScene(scene) {
    const current = document.querySelector('.scene-layer[data-role="current"]');
    const next = document.querySelector('.scene-layer[data-role="next"]');
    if (!current || !next) return;
    const { el, media } = companionBuildMedia(scene);
    const inactive = (companionSceneActive === current) ? next : current;
    inactive.innerHTML = '';
    inactive.appendChild(el);
    companionShowInfo(scene);
    const onReady = () => {
      current.dataset.active = 'false';
      inactive.dataset.active = 'true';
      const old = companionSceneActive;
      companionSceneActive = inactive;
      companionScheduleNext(scene, media);
      if (old) setTimeout(() => { if (old !== companionSceneActive) old.innerHTML = ''; }, 1500);
    };
    if (scene.type === 'video' && !scene.src) onReady();
    else if (media.complete && media.naturalWidth > 0) onReady();
    else media.addEventListener('load', onReady, { once: true });
  }

  function companionNextScene() {
    companionSceneIdx = (companionSceneIdx + 1) % COMPANION_SCENES.length;
    companionRenderScene(COMPANION_SCENES[companionSceneIdx]);
  }

  function companionStartScene() {
    companionSceneIdx = 0;
    companionSceneActive = null;
    clearTimeout(companionSceneTimer);
    companionRenderScene(COMPANION_SCENES[0]);
    ['mousemove', 'mousedown', 'touchstart'].forEach((ev) =>
      document.addEventListener(ev, companionRevealInfo, { passive: true }));
  }

  // 真实场景加载/轮询（协议层 companion.scene；旁路 agent 的 scene_render 产出）。
  // 有场景（imageUrl 非空）→ 停止 demo 轮播、显示当前场景单图（签名变化才重绘）；
  // 无场景 → 回落 demo 序列（渐进增强，保留兜底）。
  async function loadCompanionScene() {
    if (!connected || currentView() !== 'companion') return;
    const character = companionCharacter || companionDefaultCharacter;
    if (!character) return;
    let scene = null;
    try {
      scene = await client.request('companion.scene', { character });
    } catch (e) {
      scene = null; // 查询失败保持现状（demo 兜底）
    }
    if (scene && scene.imageUrl) {
      if (!companionLiveScene || companionLiveSceneSig !== (scene.signature || '')) {
        companionLiveScene = scene;
        companionLiveSceneSig = scene.signature || '';
        // 切换到场景单图：live 驻留（companionScheduleNext 不自动切下一个）
        clearTimeout(companionSceneTimer);
        companionRenderScene({
          type: 'image',
          src: scene.imageUrl,
          title: scene.prompt || '当前场景',
          meta: scene.createdAt ? '场景 · ' + fmtVoiceTime(scene.createdAt) : '场景',
          live: true,
        });
      }
    } else if (companionLiveScene) {
      // 场景被清空（角色无 scene.png）→ 回落 demo 轮播
      companionLiveScene = null;
      companionLiveSceneSig = '';
      companionStartScene();
    }
  }

  // 对话框显示文本（message.text 事件流更新）
  function companionSetDialogue(text) {
    const p = document.querySelector('#companion-dialogue .dialogue-text');
    if (p) p.textContent = text || '';
    const wrap = $('#companion-dialogue');
    if (wrap) wrap.dataset.forceVisible = 'true';
  }

  // 对话框流式追加（message.text 是流式事件，逐段累积）
  let companionDialogueBuf = '';
  function companionAppendDialogue(content) {
    companionDialogueBuf += (content || '');
    companionSetDialogue(companionDialogueBuf);
  }
  function companionResetDialogue(text) {
    companionDialogueBuf = '';
    companionSetDialogue(text || '');
  }

  // 历史浮层：按「组」分页展示（一组 = 一问一答）。
  // 初始显示最近 10 组，「显示更多」每次往上再加 10 组。
  // 台词来源：companion_say 工具记录（as=think 不展示）；
  // 旧会话无工具记录时回落 text（与表达契约一致）。
  const COMPANION_HISTORY_PAGE = 10;
  let companionHistoryPairs = [];
  let companionHistoryShown = 0;

  function companionBuildPairs(msgs) {
    const hasSay = (msgs || []).some(
      (m) => m && m.type === 'tool_call' && m.name === 'companion_say',
    );
    const pairs = [];
    let cur = null;
    const flush = () => { if (cur && (cur.user || cur.assistant)) pairs.push(cur); cur = null; };
    (msgs || []).forEach((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'user_input' || m.type === 'user') {
        flush();
        cur = { user: m.content || '', assistant: '' };
        return;
      }
      if (m.type === 'tool_call' && m.name === 'companion_say') {
        let input = m.input;
        try { input = typeof input === 'string' ? JSON.parse(input) : input; } catch (e) { input = null; }
        if (!input) return;
        // 与工具侧渲染一致：[动作]（心声）内容
        const parts = [];
        if (input.action) parts.push('[' + input.action + ']');
        if (input.think) parts.push('（' + input.think + '）');
        if (input.text) parts.push(input.text);
        const spoken = parts.join('');
        if (!spoken) return;
        if (!cur) cur = { user: '', assistant: '' };
        cur.assistant = cur.assistant ? cur.assistant + '\n' + spoken : spoken;
        return;
      }
      if (m.type === 'text' && !hasSay) {
        if (!cur) cur = { user: '', assistant: '' };
        cur.assistant = cur.assistant ? cur.assistant + '\n' + (m.content || '') : (m.content || '');
      }
    });
    flush();
    return pairs;
  }

  // 台词行（companion.sayHistory 数据源）：sayHistory 是倒序（新→旧），
  // 渲染前翻转为正序（旧→新），每条是一条 assistant 台词（含 [动作]/（心声）前缀，
  // 与 companion_say 工具渲染一致；mode=think 弱化显示）。去重：按 sayId 收敛重复。
  function companionBuildSayRows(entries) {
    const seen = new Set();
    const rows = [];
    const es = Array.isArray(entries) ? entries : [];
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (!e || !e.text) continue;
      if (e.sayId) {
        if (seen.has(e.sayId)) continue;
        seen.add(e.sayId);
      }
      const parts = [];
      if (e.action) parts.push('[' + e.action + ']');
      if (e.think) parts.push('（' + e.think + '）');
      parts.push(e.text);
      rows.push({
        user: '',
        assistant: parts.join(''),
        sayMode: e.mode,
        sayAt: e.at || '',
        sayId: e.sayId || '',
      });
    }
    return rows;
  }

  function historyPairHtml(pair) {
    let html = '';
    if (pair.user) {
      html += `<div class="history-turn user"><div class="history-avatar"><i data-lucide="user" class="w-4 h-4"></i></div><div class="history-bubble"><p>${esc(pair.user)}</p></div></div>`;
    }
    if (pair.assistant) {
      // sayMode=think（心声）：弱化显示，与实时对话框契约一致
      const think = pair.sayMode === 'think';
      const time = pair.sayAt ? `<span class="history-time">${esc(fmtVoiceTime(pair.sayAt))}</span>` : '';
      html += `<div class="history-turn assistant${think ? ' think' : ''}"><div class="history-avatar"><i data-lucide="sparkles" class="w-4 h-4"></i></div><div class="history-bubble"><p>${esc(pair.assistant)}</p>${time}</div></div>`;
    }
    return html;
  }

  function renderCompanionHistoryPage() {
    const list = $('#history-list');
    if (!list) return;
    const total = companionHistoryPairs.length;
    const start = Math.max(0, total - companionHistoryShown);
    const visible = companionHistoryPairs.slice(start);
    const more = start > 0;
    list.innerHTML =
      (more ? `<button id="history-more" class="history-more">显示更多（还有 ${start} 组）</button>` : '') +
      visible.map(historyPairHtml).join('');
    const moreBtn = $('#history-more');
    if (moreBtn) moreBtn.addEventListener('click', showMoreCompanionHistory);
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    const scroll = $('#history-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function showMoreCompanionHistory() {
    const scroll = $('#history-scroll');
    const before = scroll ? scroll.scrollHeight : 0;
    companionHistoryShown += COMPANION_HISTORY_PAGE;
    renderCompanionHistoryPage();
    // 视口锚定：往上插入内容后保持用户当前看到的位置
    if (scroll) scroll.scrollTop = Math.max(0, scroll.scrollHeight - before);
  }

  // 台词历史（companion.sayHistory，按角色持久化）优先；旧会话无台词记录时回落消息级历史。
  // sayHistory 是可靠台词源（companion_say 落盘，不受 JSONL 工具痕迹清理影响）；
  // message.history 含 user 消息与历史台词，作为回落路径（行为同旧版）。
  async function loadCompanionHistory() {
    if (!connected) return;
    const sid = companionSessionId || currentSessionId;
    if (!sid) return;
    const character = companionCharacter || companionDefaultCharacter;
    try {
      // 主源：sayHistory（角色维度台词，倒序）
      let sayRows = [];
      if (character) {
        const sh = await client.request('companion.sayHistory', { character, limit: 100 }).catch(() => null);
        sayRows = (sh && Array.isArray(sh.entries)) ? sh.entries : [];
      }
      if (sayRows.length > 0) {
        companionHistoryPairs = companionBuildSayRows(sayRows);
        companionHistoryShown = Math.min(COMPANION_HISTORY_PAGE, companionHistoryPairs.length);
        renderCompanionHistoryPage();
        return;
      }
      // 回落：消息级历史（无 sayHistory 记录，如旧会话）
      const res = await client.request('message.history', { sessionId: sid, limit: 400 });
      companionHistoryPairs = companionBuildPairs((res && res.messages) || []);
      companionHistoryShown = Math.min(COMPANION_HISTORY_PAGE, companionHistoryPairs.length);
      renderCompanionHistoryPage();
    } catch (e) {
      // 历史加载失败静默
    }
  }

  // ── 语音重放列表（协议层 companion.voiceList；历史浮层「它说过的话」）──
  // 数据源是生成语音库（TTS 输出侧），按角色倒序，含可播放 URL。
  let companionVoiceRows = [];
  let companionVoiceReplayAudio = null;

  function fmtVoiceTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderVoiceReplayList() {
    const list = $('#voice-replay-list');
    if (!list) return;
    if (!companionVoiceRows.length) {
      list.innerHTML = '<div class="voice-empty">还没有留下声音</div>';
      return;
    }
    list.innerHTML = companionVoiceRows.map((v, i) => {
      const meta = [
        v.emotion ? esc(v.emotion) : '',
        v.durationMs ? (v.durationMs / 1000).toFixed(1) + 's' : '',
        v.createdAt ? esc(fmtVoiceTime(v.createdAt)) : '',
      ].filter(Boolean).map((m) => `<span>${m}</span>`).join('');
      return `
      <div class="voice-item" data-voice-idx="${i}" data-voice-url="${escAttr(v.url || '')}">
        <div class="voice-play"><i data-lucide="play" class="w-4 h-4"></i></div>
        <div class="voice-main">
          <div class="voice-text">${esc(v.text || '')}</div>
          ${meta ? `<div class="voice-meta">${meta}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.voice-item').forEach((el) => {
      el.addEventListener('click', () => playVoiceReplayItem(el));
    });
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  function playVoiceReplayItem(el) {
    const url = el.getAttribute('data-voice-url');
    if (!url) return;
    try {
      if (companionVoiceReplayAudio) {
        companionVoiceReplayAudio.pause();
        companionVoiceReplayAudio = null;
      }
      document.querySelectorAll('.voice-item.playing').forEach((n) => n.classList.remove('playing'));
      const audio = new Audio(url);
      companionVoiceReplayAudio = audio;
      el.classList.add('playing');
      audio.addEventListener('ended', () => el.classList.remove('playing'));
      void audio.play().catch(() => { el.classList.remove('playing'); });
    } catch (e) { /* 播放失败静默 */ }
  }

  async function loadCompanionVoiceReplay() {
    const list = $('#voice-replay-list');
    if (!connected) return;
    const character = companionCharacter || companionDefaultCharacter;
    if (!character) {
      companionVoiceRows = [];
      renderVoiceReplayList();
      return;
    }
    try {
      const res = await client.request('companion.voiceList', { character });
      companionVoiceRows = (res && Array.isArray(res.voices)) ? res.voices : [];
      renderVoiceReplayList();
    } catch (e) {
      companionVoiceRows = [];
      if (list) list.innerHTML = '<div class="voice-empty">语音列表加载失败</div>';
    }
  }

  // 陪伴语音：companion.voice 事件 → 播放台词语音（只保留最新一条）
  let companionVoiceAudio = null;
  // 当前屏幕上这句台词的 sayId（companion.say 事件带来）。
  // 语音是异步合成的（长句数分钟），到达时屏幕可能已推进到下一句 ——
  // 播放前必须比对，过期语音丢弃（文件仍在库中，"它说过的话"里可重放）。
  let companionCurrentSayId = '';
  function handleCompanionVoice(payload) {
    if (!payload || payload.state !== 'ready' || !payload.url) {
      if (payload && payload.state === 'error' && currentView() === 'companion') {
        // 只对当前这句提示失败，迟到的失败提示直接忽略
        if (!payload.sayId || payload.sayId === companionCurrentSayId) {
          companionSetDialogue('🔇 ' + (payload.message || '语音合成失败'));
        }
      }
      return;
    }
    if (!companionActive || currentView() !== 'companion') return;
    // ★ 时序守卫：sayId 对不上 = 这条语音属于早已翻篇的台词，不播
    if (payload.sayId && payload.sayId !== companionCurrentSayId) return;
    try {
      if (companionVoiceAudio) { companionVoiceAudio.pause(); }
      const audio = new Audio(payload.url);
      companionVoiceAudio = audio;
      void audio.play().catch(() => { /* 自动播放被拦截：用户交互后恢复 */ });
    } catch (e) { /* 播放失败静默 */ }
  }

  // 陪伴表达：companion.say 事件 → 对话框（speak=台词，think=心声弱显示）
  function handleCompanionSay(payload) {
    if (!payload || currentView() !== 'companion') return;
    // 记录当前句标识：后续 companion.voice 事件据此判断是否过期（见 handleCompanionVoice）
    if (payload.sayId) companionCurrentSayId = payload.sayId;
    const text = payload.text || '';
    const wrap = $('#companion-dialogue');
    companionResetDialogue(text);
    if (wrap) wrap.dataset.mode = 'speak';
    if (payload.tone) {
      const p = document.querySelector('#companion-dialogue .dialogue-text');
      if (p) p.title = '语气：' + payload.tone;
    }
  }

  // ── 陪伴模式切换（协议层 companion.activate / deactivate） ──
  async function toggleCompanion() {
    if (!connected) return;
    try {
      if (companionActive) {
        // 退出：调 deactivate → 切回 chat 视图
        await client.request('companion.deactivate');
        companionActive = false;
        companionCharacter = '';
        updateCompanionButton();
        goTo('#/chat');
      } else {
        // 进入：调 activate（切换 Router + Session + BypassAgent）；带上设置的默认角色
        const res = await client.request(
          'companion.activate',
          companionDefaultCharacter ? { character: companionDefaultCharacter } : {},
        );
        companionActive = true;
        companionCharacter = (res && res.character) || '';
        updateCompanionButton();
        goTo('#/companion');
      }
    } catch (e) {
      appendMsg('error', '陪伴模式切换失败: ' + ((e && e.message) || '未知错误'));
    }
  }

  /** 更新星形按钮视觉状态 */
  function updateCompanionButton() {
    const btn = document.querySelector('.companion-entry-btn');
    if (!btn) return;
    if (companionActive) {
      btn.style.color = 'var(--hyacinth-primary)';
      btn.style.backgroundColor = 'color-mix(in srgb, var(--hyacinth-primary) 20%, transparent)';
      btn.style.borderColor = 'var(--hyacinth-primary)';
    } else {
      btn.style.color = '';
      btn.style.backgroundColor = '';
      btn.style.borderColor = '';
    }
  }

  // 进入陪伴视图：先 activate 后端，再启动场景 + 加载历史
  async function loadCompanion() {
    if (!connected) return;
    // 进入/重进陪伴视图：重置当前句标识（避免残留上一轮的 sayId 拦截新语音）
    companionCurrentSayId = '';
    try {
      // 先通过协议层激活后端 Router（切换 session / bypass agent）
      if (!companionActive) {
        const res = await client.request(
          'companion.activate',
          companionDefaultCharacter ? { character: companionDefaultCharacter } : {},
        );
        companionActive = true;
        companionCharacter = (res && res.character) || '';
        companionSessionId = currentSessionId; // 历史查询用当前会话（协议层按实时目录解析）
        updateCompanionButton();
      }
      companionSessionId = currentSessionId;
      // 场景：先启动 demo 兜底，再尝试真实场景（有 scene.png 则切换为 live 单图）；
      // 轮询 15s 检测 scene_render 变化（旁路 agent 写文件是被动产物，无事件推送）
      companionStartScene();
      await loadCompanionScene();
      if (companionScenePollTimer) clearInterval(companionScenePollTimer);
      companionScenePollTimer = setInterval(loadCompanionScene, 15000);
      await loadCompanionHistory();
    } catch (e) {
      companionSetDialogue('进入陪伴模式失败: ' + ((e && e.message) || '未知错误'));
    }
  }

  // 发送消息 → message.chat（回显用户到历史，等待 message.text 事件更新对话框）
  function sendCompanion() {
    const input = $('#companion-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (!connected) { companionSetDialogue('尚未连接后端，无法发送'); return; }
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    client.request('message.chat', { content: text }).catch((e) => {
      companionSetDialogue('发送失败: ' + ((e && e.message) || '未知错误'));
    });
  }

  // 绑定陪伴视图交互：输入/发送、历史浮层开关、媒体浮层、textarea 自适应
  function bindCompanionView() {
    const input = $('#companion-input');
    const sendBtn = $('#companion-send');
    if (sendBtn) sendBtn.addEventListener('click', sendCompanion);
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendCompanion();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      });
    }

    // 历史浮层开关（message.history 数据驱动）
    const history = $('#companion-history');
    const toggle = $('#history-toggle');
    const close = $('#history-close');
    const openHistory = () => {
      if (!history) return;
      history.classList.add('open');
      history.setAttribute('aria-hidden', 'false');
      loadCompanionHistory();
    };
    const closeHistory = () => {
      if (!history) return;
      history.classList.remove('open');
      history.setAttribute('aria-hidden', 'true');
    };
    if (toggle) toggle.addEventListener('click', openHistory);
    if (close) close.addEventListener('click', closeHistory);

    // 浮层 tab：对话（message.history） / 它说过的话（companion.voiceList）
    const historyTabs = document.querySelectorAll('.history-tab');
    const switchHistoryTab = (name) => {
      historyTabs.forEach((t) => {
        t.classList.toggle('active', t.getAttribute('data-history-tab') === name);
      });
      const chatPane = $('#history-scroll');
      const voicePane = $('#voice-scroll');
      if (chatPane) chatPane.hidden = name !== 'chat';
      if (voicePane) voicePane.hidden = name !== 'voice';
      if (name === 'voice') loadCompanionVoiceReplay();
    };
    historyTabs.forEach((t) => {
      t.addEventListener('click', () => switchHistoryTab(t.getAttribute('data-history-tab')));
    });
    if (history) history.addEventListener('click', (e) => {
      if (e.target === history) closeHistory();
    });

    // 媒体浮层（图片/视频/音频预览）
    const overlay = $('#dialogue-media-overlay');
    const mTrigger = $('#dialogue-media-trigger');
    const mClose = $('#dialogue-media-close');
    if (mTrigger) mTrigger.addEventListener('click', () => {
      if (overlay) { overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false'); }
    });
    if (mClose) mClose.addEventListener('click', () => {
      if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
    });
    if (overlay) overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
    });

    // Escape 关闭浮层
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (overlay && overlay.classList.contains('open')) {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
      }
      if (history && history.classList.contains('open')) {
        history.classList.remove('open');
        history.setAttribute('aria-hidden', 'true');
      }
    });

    // 退出陪伴模式：先 deactivate 后端，再导航回 chat
    const exitBtn = document.querySelector('[data-dom-id="companion-exit"]');
    if (exitBtn) exitBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (companionActive && connected) {
        try { await client.request('companion.deactivate'); } catch { /* best-effort */ }
        companionActive = false;
        companionCharacter = '';
        updateCompanionButton();
      }
      goTo('#/chat');
    });
  }

  // ════════════════════════════════════════════════════════════
  // 声音管理（音色库资产 + 生成语音库缓存治理）
  // ════════════════════════════════════════════════════════════
  // 音色=用户资产（不可重建）→ 登记/删除需谨慎；生成语音=缓存 → 可安全清理。
  // 数据与操作都走协议层：companion.voiceStats / voiceRegister / voiceDelete / voicePrune。
  function fmtBytes(n) {
    if (!n || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function loadVoiceManager() {
    if (!connected) return;
    try {
      const st = await client.request('companion.voiceStats');
      renderVoiceManager(st);
    } catch (e) {
      const list = $('#vm-voice-list');
      if (list) list.innerHTML = '<div class="vm-empty">加载失败（后端未连接或不支持）</div>';
    }
  }

  function renderVoiceManager(st) {
    if (!st) return;
    const vSum = $('#vm-voices-summary');
    const gSum = $('#vm-gen-summary');
    if (vSum) vSum.textContent = `${st.voices.count} 个音色 · ${fmtBytes(st.voices.totalBytes)}`;
    if (gSum) gSum.textContent = `${st.generated.count} 条 · ${fmtBytes(st.generated.totalBytes)} · 自动保留 ${st.keepPerCharacter}/角色`;

    const vList = $('#vm-voice-list');
    if (vList) {
      if (!st.voices.entries.length) {
        vList.innerHTML = '<div class="vm-empty">还没有登记音色。填入参考音频路径登记一个（如 IndexTTS2 examples 里的 wav）</div>';
      } else {
        vList.innerHTML = st.voices.entries.map((v) => `
          <div class="vm-item ${v.bind ? 'vm-bound' : ''}">
            <span class="vm-name">${esc(v.id)}${v.bind ? ' <span style="color:var(--hyacinth-primary)">[' + esc(v.bind) + ']</span>' : ''}${v.desc ? ' — ' + esc(v.desc) : ''}</span>
            <span class="vm-meta">${esc(v.file)} · ${fmtBytes(v.bytes)}</span>
            <button class="vm-del" data-vm-del="${escAttr(v.id)}" title="删除音色（不可恢复）" type="button">×</button>
          </div>`).join('');
        vList.querySelectorAll('[data-vm-del]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-vm-del') || '';
            if (!window.confirm(`删除音色「${id}」？\n参考音频不可重建，删除后无法恢复。`)) return;
            try {
              await client.request('companion.voiceDelete', { id });
              appendMsg('system', `音色 ${id} 已删除`);
              loadVoiceManager();
            } catch (e) {
              appendMsg('error', '删除失败: ' + ((e && e.message) || '未知错误'));
            }
          });
        });
      }
    }

    const gList = $('#vm-gen-list');
    if (gList) {
      gList.innerHTML = st.generated.byCharacter.length
        ? st.generated.byCharacter.map((c) => `
          <div class="vm-item">
            <span class="vm-name">${esc(c.character)}</span>
            <span class="vm-meta">${c.count} 条 · ${fmtBytes(c.bytes)}</span>
          </div>`).join('')
        : '<div class="vm-empty">还没有生成过语音</div>';
    }

    // 清理用的角色下拉
    const pruneSel = $('#vm-prune-char');
    if (pruneSel) {
      const cur = pruneSel.value;
      pruneSel.innerHTML = st.generated.byCharacter.length
        ? st.generated.byCharacter.map((c) => `<option value="${escAttr(c.character)}">${esc(c.character)}</option>`).join('')
        : '<option value="">（暂无角色）</option>';
      if (cur && st.generated.byCharacter.some((c) => c.character === cur)) pruneSel.value = cur;
    }
  }

  function bindVoiceManager() {
    const addBtn = $('#vm-voice-add');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const pathEl = $('#vm-voice-path');
      const idEl = $('#vm-voice-id');
      const p = (pathEl?.value || '').trim();
      if (!p) { appendMsg('system', '请填入参考音频的绝对路径'); return; }
      addBtn.disabled = true;
      try {
        const params = { path: p };
        const id = (idEl?.value || '').trim();
        if (id) params.id = id;
        const res = await client.request('companion.voiceRegister', params);
        appendMsg('system', `音色 ${res.voice.id} 已登记`);
        if (pathEl) pathEl.value = '';
        if (idEl) idEl.value = '';
        loadVoiceManager();
      } catch (e) {
        appendMsg('error', '登记失败: ' + ((e && e.message) || '未知错误'));
      } finally {
        addBtn.disabled = false;
      }
    });

    const pruneBtn = $('#vm-prune');
    if (pruneBtn) pruneBtn.addEventListener('click', async () => {
      const sel = $('#vm-prune-char');
      const keepEl = $('#vm-keep-n');
      const character = sel?.value || '';
      if (!character) { appendMsg('system', '暂无可清理的角色'); return; }
      const params = { character };
      const keepRaw = keepEl?.value ? parseInt(keepEl.value, 10) : NaN;
      if (Number.isFinite(keepRaw) && keepRaw >= 0) params.keep = keepRaw;
      pruneBtn.disabled = true;
      try {
        const res = await client.request('companion.voicePrune', params);
        appendMsg('system', `已清理 ${res.removed} 条（${res.character} 现存 ${res.remaining} 条，保留上限 ${res.keep}）`);
        loadVoiceManager();
      } catch (e) {
        appendMsg('error', '清理失败: ' + ((e && e.message) || '未知错误'));
      } finally {
        pruneBtn.disabled = false;
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // 工具包 / 工具 / MCP 管理（bundle.* / tool.* / mcp.* 域）
  // ════════════════════════════════════════════════════════════
  function escAttr(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  async function loadToolsAndMCP() {
    if (!connected) return;
    loadBundles().catch(() => {});
    loadTools().catch(() => {});
    loadMCP().catch(() => {});
  }

  // ── 工具包 ─────────────────────────────────────────────────
  async function loadBundles() {
    const listEl = $('#bundle-list');
    if (!listEl) return;
    const res = await client.request('bundle.list');
    if (!res) return;
    const { allMode, bundles } = res;
    const modeLabel = $('#bundle-mode-label');
    if (modeLabel) modeLabel.textContent = allMode
      ? '当前：全量模式（不限制工具）'
      : '当前：已激活工具包模式（仅包内工具可用）';
    const deactBtn = $('#bundle-deactivate-btn');
    if (deactBtn) deactBtn.style.display = allMode ? 'none' : 'inline-flex';

    listEl.innerHTML = '';
    (bundles || []).forEach((b) => {
      const row = el('div', 'border border-border rounded-lg p-3 flex flex-col gap-2' + (b.active ? ' bg-primary/5 border-primary/30' : ''));
      const head = el('div', 'flex items-center gap-2 flex-wrap');
      head.appendChild(el('span', 'font-medium text-sm text-foreground', b.name));
      if (b.builtin) head.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground', '内置'));
      if (b.active) head.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary', '已激活'));
      if (b.name === 'common') head.appendChild(el('span', 'text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground', '始终加载'));
      head.appendChild(el('span', 'text-xs text-muted-foreground ml-auto', b.tools.length ? `${b.tools.length} 个工具` : '全量'));
      row.appendChild(head);
      row.appendChild(el('div', 'text-xs text-muted-foreground', b.description || ''));
      if (b.tools && b.tools.length) {
        row.appendChild(el('div', 'text-[11px] font-mono text-muted-foreground leading-relaxed break-all', b.tools.join('、')));
      }
      const ops = el('div', 'flex items-center gap-2');
      const actBtn = el('button', 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs hover:bg-muted transition-colors');
      actBtn.innerHTML = '<i data-lucide="power" class="w-3 h-3"></i><span>' + (b.active ? '取消激活' : '激活') + '</span>';
      actBtn.onclick = () => {
        if (!connected) return;
      if (b.active) {
        client.request('bundle.deactivate').then(loadBundles).catch((e) => appendMsg('error', '操作失败: ' + (e && e.message)));
      } else {
        client.request('bundle.activate', { names: [b.name] }).then(() => { loadBundles(); loadTools(); })
          .catch((e) => appendMsg('error', '激活失败: ' + (e && e.message)));
      }
      };
      ops.appendChild(actBtn);
      if (!b.builtin) {
        const delBtn = el('button', 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs hover:bg-muted transition-colors');
        delBtn.innerHTML = '<i data-lucide="trash-2" class="w-3 h-3"></i><span>删除</span>';
        delBtn.style.color = 'var(--state-error)';
        delBtn.onclick = () => {
          if (!connected) return;
          if (!window.confirm(`删除工具包「${b.name}」？`)) return;
          client.request('bundle.delete', { name: b.name }).then(() => {
            bundleNamesCache = [];
            loadBundles();
            loadTools();
            appendMsg('system', '已删除工具包 ' + b.name);
          }).catch((e) => appendMsg('error', '删除失败: ' + (e && e.message)));
        };
        ops.appendChild(delBtn);
      }
      row.appendChild(ops);
      listEl.appendChild(row);
    });
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  // ── 工具列表 ───────────────────────────────────────────────
  // 工具包列表缓存：「加入工具包」下拉与包名徽章的 × 都依赖它
  let bundleNamesCache = [];

  async function loadTools() {
    const listEl = $('#tools-list');
    if (!listEl) return;
    const res = await client.request('tool.list');
    if (!res || !res.tools) return;
    const rows = res.tools;
    const countEl = $('#tools-count');
    if (countEl) countEl.textContent = String(rows.length);

    // 下拉用的包名列表只从 tool.list 的归属里推不出来（不属于任何包的工具也要能加入），
    // 所以单独取一次；失败不影响主列表渲染
    if (bundleNamesCache.length === 0) {
      try {
        const bres = await client.request('tool.bundles');
        if (bres && bres.bundles) bundleNamesCache = bres.bundles.map((b) => b.name);
      } catch (e) { /* 忽略：下拉会退化为空 */ }
    }

    const q = ($('#tools-filter') && $('#tools-filter').value || '').toLowerCase();
    const srcFilter = ($('#tools-source-filter') && $('#tools-source-filter').value) || '';
    const visible = rows.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q)) return false;
      if (srcFilter && (t.source || 'builtin') !== srcFilter) return false;
      return true;
    });

    listEl.innerHTML = '';
    if (!visible.length) {
      listEl.appendChild(el('div', 'px-3 py-4 text-center text-xs text-muted-foreground', '无匹配工具'));
      return;
    }

    visible.forEach((t) => {
      const row = el('div', 'px-3 py-2 flex items-center gap-2 flex-wrap bg-card');

      // 工具名
      row.appendChild(el('span', 'font-mono text-xs text-foreground w-56 shrink-0 truncate', t.name));

      // 来源徽章：MCP 工具显示所属服务器，否则显示来源类型
      const source = t.source || 'builtin';
      if (source !== 'builtin') {
        row.appendChild(makeBadge(
          source === 'mcp' ? ('MCP' + (t.mcpServer ? ' · ' + t.mcpServer : '')) : source,
          source === 'mcp' ? 'var(--hyacinth-accent, var(--state-info))' : 'var(--muted-foreground)',
        ));
      }

      // 状态徽章
      const status = t.bundleFiltered ? '被过滤' : (t.enabled ? '可用' : '已禁用');
      const statusColor = t.bundleFiltered ? 'var(--state-warning)' : (t.enabled ? 'var(--state-success)' : 'var(--state-error)');
      row.appendChild(makeBadge(status, statusColor));

      // 所属工具包：点 × 移出该包
      (t.bundles || []).forEach((bname) => {
        row.appendChild(makeBundleChip(bname, t.name));
      });

      if (t.description) {
        row.appendChild(el('span', 'text-xs text-muted-foreground flex-1 min-w-[120px] truncate', t.description));
      }

      // 「加入工具包」下拉
      row.appendChild(makeAddToBundleSelect(t.name, t.bundles || []));

      // 启停开关
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!t.enabled;
      toggle.disabled = t.bundleFiltered;
      toggle.className = 'w-3.5 h-3.5 accent-[var(--hyacinth-primary)] shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
      toggle.title = t.bundleFiltered ? '被工具包过滤，无法直接开关（先激活包含它的工具包或回全量模式）' : '';
      toggle.onchange = () => {
        if (!connected) return;
        client.request('tool.toggle', { name: t.name, enabled: toggle.checked })
          .then(() => { /* keep */ })
          .catch((e) => { toggle.checked = !toggle.checked; appendMsg('error', '切换失败: ' + (e && e.message)); });
      };
      row.appendChild(toggle);

      listEl.appendChild(row);
    });
  }

  /** 小徽章（颜色一律内联 style：动态 className 不会被 Tailwind JIT 收集） */
  function makeBadge(text, color) {
    const b = el('span', 'text-[10px] px-1.5 py-0.5 rounded shrink-0');
    b.textContent = text;
    b.style.color = color;
    b.style.backgroundColor = 'color-mix(in srgb, ' + color + ' 12%, transparent)';
    return b;
  }

  /** 工具包 chip，带 × 移出按钮 */
  function makeBundleChip(bundleName, toolName) {
    const chip = el('span', 'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0');
    chip.style.color = 'var(--hyacinth-primary)';
    chip.style.backgroundColor = 'color-mix(in srgb, var(--hyacinth-primary) 12%, transparent)';
    chip.appendChild(el('span', '', bundleName));
    const x = el('button', 'shrink-0 leading-none hover:opacity-100 opacity-60');
    x.type = 'button';
    x.textContent = '×';
    x.title = '从「' + bundleName + '」移出 ' + toolName;
    x.style.background = 'none';
    x.style.border = 'none';
    x.style.cursor = 'pointer';
    x.style.color = 'inherit';
    x.onclick = () => {
      if (!connected) return;
      if (!window.confirm(`将「${toolName}」移出工具包「${bundleName}」？`)) return;
      x.disabled = true;
      client.request('bundle.removeTools', { name: bundleName, tools: [toolName] })
        .then(() => {
          appendMsg('system', `已将 ${toolName} 移出 ${bundleName}`);
          bundleNamesCache = [];
          loadTools();
          loadBundles();
        })
        .catch((e) => { x.disabled = false; appendMsg('error', '移出失败: ' + (e && e.message)); });
    };
    chip.appendChild(x);
    return chip;
  }

  /** 「加入工具包」下拉：只列出该工具尚未加入的包 */
  function makeAddToBundleSelect(toolName, owned) {
    const ownedSet = new Set(owned);
    const candidates = bundleNamesCache.filter((n) => !ownedSet.has(n));
    const sel = document.createElement('select');
    sel.className = 'h-6 px-1.5 rounded border border-border bg-background text-[10px] text-foreground shrink-0 cursor-pointer';
    sel.style.maxWidth = '7.5rem';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '加入工具包…';
    sel.appendChild(placeholder);
    candidates.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    });
    if (!candidates.length) {
      sel.disabled = true;
      placeholder.textContent = owned.length ? '已在全部包中' : '无可用包';
    }
    sel.onchange = () => {
      const target = sel.value;
      if (!target) return;
      if (!connected) { sel.value = ''; return; }
      sel.disabled = true;
      client.request('bundle.addTools', { name: target, tools: [toolName] })
        .then(() => {
          appendMsg('system', `已将 ${toolName} 加入 ${target}`);
          bundleNamesCache = [];
          loadTools();
          loadBundles();
        })
        .catch((e) => { sel.disabled = false; sel.value = ''; appendMsg('error', '加入失败: ' + (e && e.message)); });
    };
    return sel;
  }

  // ── MCP ────────────────────────────────────────────────────
  async function loadMCP() {
    const listEl = $('#mcp-list');
    if (!listEl) return;
    const res = await client.request('mcp.list');
    if (!res || !res.servers) return;
    listEl.innerHTML = '';
    if (!res.servers.length) {
      listEl.appendChild(el('div', 'px-3 py-4 text-center text-xs text-muted-foreground', '暂无 MCP 服务器。'));
      return;
    }
    res.servers.forEach((s) => {
      const row = el('div', 'px-3 py-2.5 flex items-center gap-3 flex-wrap bg-card');

      // 名称
      row.appendChild(el('span', 'font-mono text-xs text-foreground w-44 shrink-0 truncate', s.name));

      // 启用开关（写配置文件的 _disabled）
      const enToggle = document.createElement('input');
      enToggle.type = 'checkbox';
      enToggle.checked = !!s.enabled;
      enToggle.className = 'w-3.5 h-3.5 accent-[var(--hyacinth-primary)] shrink-0 cursor-pointer';
      enToggle.title = s.enabled ? '已启用（点击禁用）' : '已禁用（点击启用）';
      enToggle.onchange = () => {
        if (!connected) { enToggle.checked = !enToggle.checked; return; }
        const action = enToggle.checked ? 'mcp.enable' : 'mcp.disable';
        enToggle.disabled = true;
        client.request(action, { name: s.name })
          .then(() => {
            appendMsg('system', `${s.name} 已${enToggle.checked ? '启用' : '禁用'}`);
            loadMCP().then(loadTools); // 工具数会变，顺带刷新工具列表
          })
          .catch((e) => { enToggle.checked = !enToggle.checked; appendMsg('error', '操作失败: ' + (e && e.message)); })
          .finally(() => { enToggle.disabled = false; });
      };
      row.appendChild(enToggle);
      row.appendChild(el('span', 'text-xs shrink-0', s.enabled ? '已启用' : '已禁用'));

      // 连接状态
      const ok = !!s.connected;
      const dot = el('span', 'w-2 h-2 rounded-full shrink-0');
      dot.style.backgroundColor = ok ? 'var(--state-success)' : 'var(--state-error)';
      row.appendChild(dot);
      const connText = !s.enabled ? '未启用' : (ok ? '已连接' : '未连接');
      row.appendChild(el('span', 'text-xs shrink-0 ' + (ok ? 'text-success' : 'text-muted-foreground'), connText));
      row.appendChild(el('span', 'text-xs text-muted-foreground shrink-0', s.toolCount + ' 个工具'));

      // 来源文件 / 启动方式
      const meta = [];
      if (s.file) meta.push(shortenPath(s.file));
      if (s.command) meta.push(s.command + (s.url ? '' : ' …'));
      if (s.url) meta.push(s.url);
      if (meta.length) {
        row.appendChild(el('span', 'text-[10px] font-mono text-muted-foreground truncate', meta.join('  ·  ')));
      }
      if (s.scope === 'runtime') row.appendChild(makeBadge('热插拔', 'var(--state-warning)'));

      const ops = el('div', 'flex items-center gap-2 ml-auto');
      const rcBtn = el('button', 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs hover:bg-muted transition-colors');
      rcBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-3 h-3"></i><span>重连</span>';
      rcBtn.onclick = () => {
        if (!connected) return;
        rcBtn.disabled = true;
        client.request('mcp.reconnect', { name: s.name }).then(() => { appendMsg('system', '已重连 ' + s.name); loadMCP(); })
          .catch((e) => appendMsg('error', '重连失败: ' + (e && e.message)))
          .finally(() => { rcBtn.disabled = false; });
      };
      // 热拔：只对已连接的运行时实例有意义；配置里启用的会在 reload 后重新连上，
      // 所以提示语要讲清楚，避免用户以为「移除」= 从配置里删掉
      if (s.connected) {
        const rmBtn = el('button', 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs hover:bg-muted transition-colors');
        rmBtn.innerHTML = '<i data-lucide="unplug" class="w-3 h-3"></i><span>断开</span>';
        rmBtn.style.color = 'var(--state-error)';
        rmBtn.title = '当前会话内断开连接；配置文件不受影响，重启或重载后会重新连上。要彻底关掉请用左侧启用开关。';
        rmBtn.onclick = () => {
          if (!connected) return;
          if (!window.confirm(`断开 MCP 服务器「${s.name}」？\n\n仅影响当前会话（配置文件不变）。若要永久关闭，请取消左侧的启用勾选。`)) return;
          client.request('mcp.remove', { name: s.name })
            .then(() => { appendMsg('system', '已断开 ' + s.name); loadMCP().then(loadTools); })
            .catch((e) => appendMsg('error', '断开失败: ' + (e && e.message)));
        };
        ops.appendChild(rmBtn);
      }
      ops.appendChild(rcBtn);
      row.appendChild(ops);
      listEl.appendChild(row);
    });
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  /** 把长路径缩成 ~\...\末尾两段 的形式，避免撑爆表格 */
  function shortenPath(p) {
    if (!p) return '';
    const home = (window.__hyacinthHome || '').replace(/[\\/]+$/, '');
    let out = p;
    if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = '~' + out.slice(home.length);
    const parts = out.split(/[\\/]/).filter(Boolean);
    return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : out;
  }

  function bindToolsMCP() {
    const deactBtn = $('#bundle-deactivate-btn');
    if (deactBtn) deactBtn.onclick = () => {
      if (!connected) return;
      client.request('bundle.deactivate').then(() => { loadBundles(); loadTools(); })
        .catch((e) => appendMsg('error', '操作失败: ' + (e && e.message)));
    };
    const createBtn = $('#bundle-create-btn');
    if (createBtn) {
      createBtn.onclick = () => {
        if (!connected) return;
        const name = ($('#bundle-new-name') || {}).value;
        const desc = ($('#bundle-new-desc') || {}).value;
        const toolsRaw = ($('#bundle-new-tools') || {}).value;
        if (!name) { appendMsg('error', '请输入工具包名称'); return; }
        const tools = toolsRaw.split(/[,，\s]+/).filter(Boolean);
        client.request('bundle.create', { name, description: desc, tools }).then(() => {
          appendMsg('system', '已创建工具包 ' + name);
          ['bundle-new-name', 'bundle-new-desc', 'bundle-new-tools'].forEach((id) => { const e = $('#' + id); if (e) e.value = ''; });
          bundleNamesCache = [];
          loadBundles();
          loadTools();
        }).catch((e) => appendMsg('error', '创建失败: ' + (e && e.message)));
      };
    }
    const toolsFilter = $('#tools-filter');
    if (toolsFilter) toolsFilter.addEventListener('input', loadTools);
    const toolsSrcFilter = $('#tools-source-filter');
    if (toolsSrcFilter) toolsSrcFilter.addEventListener('change', loadTools);
    const mcpAdd = $('#mcp-add-btn');
    if (mcpAdd) {
      mcpAdd.onclick = () => {
        if (!connected) return;
        const name = ($('#mcp-new-name') || {}).value;
        const command = ($('#mcp-new-command') || {}).value;
        const argsRaw = ($('#mcp-new-args') || {}).value;
        const url = ($('#mcp-new-url') || {}).value;
        if (!name) { appendMsg('error', '请输入服务器名称'); return; }
        const params = { name };
        if (url) params.url = url;
        else {
          if (!command) { appendMsg('error', '请输入启动命令或 SSE URL'); return; }
          params.command = command;
          params.args = argsRaw.split(/\s+/).filter(Boolean);
        }
        mcpAdd.disabled = true;
        client.request('mcp.add', params).then(() => {
          appendMsg('system', '已添加 MCP 服务器 ' + name);
          ['mcp-new-name', 'mcp-new-command', 'mcp-new-args', 'mcp-new-url'].forEach((id) => { const e = $('#' + id); if (e) e.value = ''; });
          loadMCP();
        }).catch((e) => appendMsg('error', '添加失败: ' + (e && e.message)))
          .finally(() => { mcpAdd.disabled = false; });
      };
    }
    // 切换到「工具」或「MCP」子标签时刷新数据（应对首次加载瞬态失败）
    ['tab-tools', 'tab-mcp'].forEach((id) => {
      const rb = $('#' + id);
      if (rb) rb.addEventListener('change', () => { if (connected) loadToolsAndMCP(); });
    });
  }

  // ════════════════════════════════════════════════════════════
  // UI 事件绑定
  // ════════════════════════════════════════════════════════════
  function bindUI() {
    bindToolsMCP();
    bindVoiceManager();
    // 新会话
    const newBtn = $('#session-new-btn');
    if (newBtn) {
      newBtn.onclick = () => {
        if (!connected) return;
        client.request('session.create', { type: 'normal' }).then((meta) => {
          currentSessionId = (meta && meta.id) || null;
          clearChat();
          appendMsg('system', '新会话已创建');
        }).catch((e) => appendMsg('error', '创建会话失败: ' + (e && e.message)));
      };
    }

    // 设置按钮 → #/settings
    const settingsBtn = $('button[aria-label="Settings"]');
    if (settingsBtn) settingsBtn.onclick = () => goTo('#/settings');

    // chat 发送
    const sendBtn = $('#chat-send-btn');
    if (sendBtn) sendBtn.onclick = () => sendChat();
    const input = $('#chat-input');
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendChat();
        }
      });
    }

    // 停止按钮 → message.stop
    const stopBtn = $('#chat-stop-btn');
    if (stopBtn) stopBtn.onclick = () => {
      client.request('message.stop').catch(() => {});
    };

    // 权限对话框按钮（permission.resolve）
    $$('#permission-dialog .dialog-btn').forEach((btn) => {
      btn.onclick = () => resolvePermission(btn.dataset.perm);
    });

    // ask_user 提交（message.askUserResolve）
    const askSubmit = $('#askuser-submit');
    if (askSubmit) askSubmit.onclick = () => resolveAskUser();

    // 附加文件：骨架占位
    const attachBtn = $('#chat-attach-btn');
    if (attachBtn) attachBtn.onclick = () => appendMsg('system', '附件上传将在后续版本支持');

    // 模型视图交互（推理强度 / 添加密钥 / Ollama 刷新）
    bindModelView();

    // 会话视图交互（搜索 / 类型筛选 / 排序 / 新建 / 加载 / 删除）
    bindSessionsView();

    // 设置视图交互（config 域：getAll / set / reset）
    bindSettingsView();

    // 陪伴视图交互（场景轮播 / 输入发送 / 历史浮层 / 媒体浮层）
    bindCompanionView();

    // 星形按钮：陪伴模式一键切换（调协议层 companion.activate/deactivate）
    const companionEntry = document.querySelector('.companion-entry-btn');
    if (companionEntry) {
      companionEntry.addEventListener('click', (e) => {
        e.preventDefault();
        toggleCompanion();
      });
    }

    // hash 路由
    window.addEventListener('hashchange', navigate);
    // 导航链接：点击当前视图（hash 不变不触发 hashchange）时手动刷新
    // 覆盖所有 a[href^="#/"]（含主导航、command-link、companion-entry/exit）
    $$('a[href^="#/"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href');
        if (href && href === location.hash) {
          e.preventDefault();
          navigate();
        }
        // 窄屏抽屉：选完导航自动收起（宽屏无副作用：类本来就没加 ✓）
        setNavDrawer(false);
      });
    });

    // ── 窄屏导航抽屉（≤900px）────────────────────────────────────
    // 背景：原先窄屏是直接 `display:none` 隐藏侧栏 ⇒ **没有导航入口** ✗。
    // 现在改为覆盖式抽屉：菜单键开合、点遮罩/选完导航/Esc 收起、回到宽屏自动复位 ✓。
    const drawerBtn = $('#nav-drawer-btn');
    if (drawerBtn) {
      drawerBtn.addEventListener('click', () => {
        const shell = $('#app-shell');
        setNavDrawer(!(shell && shell.classList.contains('nav-open')));
      });
    }
    const drawerBackdrop = $('#nav-backdrop');
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => setNavDrawer(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setNavDrawer(false);
    });
    // 视口变宽（如平板横竖切换 / 窗口拉大）⇒ 抽屉状态复位，避免残留遮挡 ✓
    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) setNavDrawer(false);
    });

    // ── 视口高度校准（真机致伤 ✗ 2026-09-20）──────────────────────
    // 用户实报「主页看不到发消息的地方」；我在无头浏览器里六种尺寸都量到输入框可见 ✗（复现不了）。
    // 机制：平板/手机浏览器的工具栏会占掉高度，而 100vh **包含**那部分 ⇒
    // shell 底部（正是输入框）被推出可视区，又因 shell 是 overflow:hidden ⇒ **永远够不着** ✗
    // 对策：用 `visualViewport.height`（真实可见高）写进 CSS 变量 --app-vh，
    // 由 CSS 用它设 shell 高 ⇒ 输入框必定落在可视区内 ✓（桌面端两者相等 ⇒ 无副作用 ✓）
    const syncAppVh = () => {
      const vv = window.visualViewport;
      const h = Math.round((vv && vv.height) || window.innerHeight || 0);
      if (h > 0) document.documentElement.style.setProperty('--app-vh', h + 'px');
    };
    syncAppVh();
    window.addEventListener('resize', syncAppVh);
    window.addEventListener('orientationchange', syncAppVh);
    if (window.visualViewport) {
      // 工具栏收起/键盘弹出时都会触发 ⇒ 跟着校准 ✓
      window.visualViewport.addEventListener('resize', syncAppVh);
    }

    // ── 对话空状态（首屏引导）──────────────────────────────────────
    // 背景：原先首屏是一大片空区 ✗（新用户不知道该干什么 ✓）。
    // 现在：无消息 ⇒ 显示引导 + 三条建议；有消息 ⇒ 收起 ✓。
    // 触发用 **MutationObserver 一处挂钩** ⇒ 自动覆盖所有路径
    // （appendMsg / clearChat / appendAssistantStream / renderHistoryMsg / loadHistory）✓
    const emptyMsgList = $('#message-list');
    const emptyPanel = $('#chat-empty');
    if (emptyMsgList && emptyPanel) {
      const syncChatEmpty = () => {
        const has = emptyMsgList.children.length > 0;
        emptyPanel.hidden = has;
        emptyMsgList.hidden = !has;
      };
      syncChatEmpty();
      new MutationObserver(syncChatEmpty).observe(emptyMsgList, { childList: true });
      // 建议按钮：**填入输入框**（不直接发送 ⇒ 用户仍可改 ✓）
      $$('#chat-empty .chat-suggestion').forEach((btn) => {
        btn.addEventListener('click', () => {
          const inp = $('#chat-input');
          if (!inp) return;
          inp.value = btn.dataset.prompt || btn.textContent || '';
          inp.focus();
          try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
        });
      });
    }
  }

  /** 窄屏导航抽屉开合（宽屏下该 class 无任何样式 ⇒ 调用亦无副作用 ✓） */
  function setNavDrawer(open) {
    const shell = $('#app-shell');
    if (!shell) return;
    shell.classList.toggle('nav-open', !!open);
    const btn = $('#nav-drawer-btn');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ════════════════════════════════════════════════════════════
  // 启动
  // ════════════════════════════════════════════════════════════
  const host = location.hostname || 'localhost';
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  // HTTPS 页面必须用 wss://（浏览器 mixed-content 会拦截 ws://）；
  // 浏览器 WebSocket 无法设置 Authorization 头 → 服务端额外接受 ?token= 查询参数。
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let wsUrl = `${wsProto}://${host}:${port}/ui`;
  const wsToken = new URLSearchParams(location.search).get('token');
  if (wsToken) wsUrl += `?token=${encodeURIComponent(wsToken)}`;

  const client = new ProtocolClient(wsUrl, {
    onOpen: () => {
      // ui.connected 事件（后端 attach 完成）后再拉数据 + 标记在线
    },
    onClose: () => {
      connected = false;
      setOnline('disconnected');
    },
    onError: () => {
      setOnline('disconnected');
    },
    onEvent: (type, payload) => handleEvent(type, payload),
  });

  // 主题：先按本地缓存立即应用（避免加载闪烁），再渲染选择器
  initThemeFromCache();
  // 启动默认模式（本地缓存的 startup.defaultMode）：陪伴模式 → 直接以陪伴视图
  // 启动（在 navigate() 前设 hash，打开即陪伴页，不闪主界面）。
  // 缓存在 ui.connected 读取配置时与设置页修改默认模式时更新；
  // 首次打开无缓存时走连接后的兜底跳转。
  try {
    if (localStorage.getItem('hyacinth.startupMode') === 'companion' && !location.hash) {
      location.hash = '#/companion';
    }
  } catch (e) { /* 隐私模式忽略 */ }
  bindUI();
  renderThemes();
  navigate();
  client.connect();

  // 暴露供调试 / 协议层调用
  window.__hyacinth = {
    client,
    request: (m, p) => client.request(m, p),
    refreshState,
    emit: (type, payload) => handleEvent(type, payload),
  };
})();
