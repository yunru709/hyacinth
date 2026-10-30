/* Hyacinth WebUI — SPA 单页应用
 * ----------------------------------------------------------------
 * 本文件就是前端源码本体：直接改这里，`pnpm run build` 会把 src/webui/ 复制到 dist/webui/。
 * （历史上由外部设计稿脚本合并生成，该一次性脚本已废弃删除。）
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
  // 启动参数 / embed 模式
  // ════════════════════════════════════════════════════════════
  // embed=1：本页作为**并行会话标签**的 iframe 被父页内嵌。
  //   - 隐藏侧栏 / 顶栏 / 标签条，固定停在 chat 视图（一页只承担"一条会话"）
  //   - `session=<id>`：连接时显式绑定已存在会话（后端做占用校验）
  //   - 就绪 / 运行状态经 postMessage 报给父页（父页只做标签条与切换）
  // 选择 iframe 而非"单页多份聊天 DOM"：本页聊天状态是模块级单例，
  // 一页渲染多条会话需要重写整套渲染管线；iframe 用浏览器隔离，
  // 后端本就"一条 WS = 一个 UiProtocolSession = 一个 AgentLoop"。
  // 关键点：非活跃标签只是 display:none —— 文档不卸载，任务照常跑。
  const URL_PARAMS = new URLSearchParams(location.search);
  const embedMode = URL_PARAMS.get('embed') === '1';
  const embedSessionParam = URL_PARAMS.get('session');
  if (embedMode) document.documentElement.classList.add('is-embed');

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

  /**
   * 交付正文（say 的 content）是 **markdown** —— 此前直接 esc() 塞进单个 <p>，
   * 于是 `**加粗**`、``` 围栏、`| 表格 |`、`# 标题` 全部按字面显示 ✗
   * （TUI 有自己的渲染器，WebUI 没有 ⇒ 两端观感不一致）。
   *
   * 现在交给 markdown.js（经典脚本，挂在 window.HyMarkdown）渲染：
   *   - 渲染器缺失（脚本没加载/被拦）或抛错 ⇒ 退回转义纯文本，**不白屏**
   *   - 空文本也至少产出一个 <p> ⇒ 流式路径 querySelector('p') 不会拿到 null
   */
  function renderRich(text) {
    const md = window.HyMarkdown;
    let html = '';
    if (md && typeof md.render === 'function') {
      try { html = md.render(text); } catch (e) { html = ''; }
    }
    if (!html) html = `<p class="md-p">${esc(text)}</p>`;
    return html;
  }

  /** 等待 KaTeX 重渲的节点 → 各自的原始文本（用于判断"是否已被更新的内容顶掉"） */
  const mathPending = new Map();

  /**
   * 渲染 markdown，并**顺带给代码块上色、把公式从降级原文补成排版**。
   *
   * 为什么放在这里而不是各个调用点：着色/公式都要在 innerHTML 之后处理
   * （一个要读 DOM 的 textContent，一个要等引擎异步到位），漏一个调用点
   * 就是"有的块有色、有的没有"。统一走这个函数就不会漏。
   *
   * 两个引擎都是按需加载的：
   *   - 代码块 ⇒ 首次遇到时注入 /vendor/hljs.min.js，加载完回扫全文档补色
   *   - 公式   ⇒ 首次遇到时注入 KaTeX（267KB），加载完重渲那些节点
   * 引擎缺失（被 CSP 拦 / 离线）时降级为纯文本 / `<code>` 原文 —— 不影响可读性。
   */
  function renderRichInto(node, text) {
    if (!node) return;
    node.innerHTML = renderRich(text);

    const hl = window.HyHighlight;
    if (hl && typeof hl.highlightIn === 'function') {
      try { hl.highlightIn(node); } catch (e) { /* 着色失败不该影响正文 */ }
    }

    // 公式：KaTeX 未就绪 + 正文真有公式 ⇒ 后台加载，到位后重渲本节点。
    // ⚠️ `!math.ready()` 这个判据不能省：ready 时 whenReady 是同步调用，
    //    重渲又会走到这里 ⇒ 无限递归。
    const math = window.HyMath;
    if (math && typeof math.whenReady === 'function' && math.needs(text) && !math.ready()) {
      mathPending.set(node, text);
      math.whenReady(() => {
        // 已被更新的文本顶掉（流式输出里同一节点会被反复重渲）⇒ 别再动它。
        // 这里**不查 isConnected**：气泡是先建节点后 appendChild 的，
        // 判定"脱离文档"会漏掉那些尚未挂载的节点（公式就永远停在原文）。
        // 对已废弃的节点重渲一次只是白干一点活，代价远小于漏渲。
        if (mathPending.get(node) !== text) return;
        mathPending.delete(node);
        renderRichInto(node, text);
      });
    } else {
      mathPending.delete(node);
    }
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
  // 并行会话标签：一条标签 = 一条会话 = 一条 iframe = 一条 WS = 一个独立 AgentLoop。
  // 2026-10-27（A2）：**没有"本页自己那格"了** —— 所有会话一律 iframe，
  // 本页的 WS 只服务侧栏 / 配置 / 会话列表等非聊天功能。
  let tabs = [];
  let activeTabId = null;
  let tabSeq = 0;

  // ════════════════════════════════════════════════════════════
  // SPA hash 路由
  // ════════════════════════════════════════════════════════════
  const VIEWS = ['chat', 'model', 'sessions', 'settings', 'schedule', 'plugins', 'skills', 'companion'];
  // data-view → data-nav-item 映射（导航里 model 对应 models）
  const NAV_BY_VIEW = { chat: 'chat', model: 'models', sessions: 'sessions', settings: 'settings', schedule: 'schedule', plugins: 'plugins', skills: 'skills' };

  function currentView() {
    // embed 本页 = 并行会话标签的一格：只承担一条会话，忽略 hash（父页 hash 不该泄漏进来）
    // 但若该标签绑定的是**陪伴会话** ⇒ 渲染沉浸视图（方案A：陪伴=独立会话标签）；
    // 否则永远只 chat，会把 companion 的 say 全挡在看不见的陪伴视图里（"发了没反应"）。
    if (embedMode) return companionActive ? 'companion' : 'chat';
    let h = (location.hash || '#/chat').replace(/^#\//, '');
    /* 「模型选择」已并入设置（2026-10-27）：旧书签 / 旧链接 #/model 不再有独立视图，
       统一落到设置页；具体选中「模型」tab 的逻辑在 applyView 里（那里能安全操作 DOM）。 */
    if (h === 'model') h = 'settings';
    return VIEWS.includes(h) ? h : 'chat';
  }

  /* 「模型」面板现在挂在设置页的「模型」tab 上（原来它是独立视图）。
     判"该不该拉模型数据"不能再看 currentView() === 'model' —— 那个值永远不会再出现。
     ⚠️ 实测坑（2026-10-27）：路由重定向后忘了改这三个补加载点 ⇒ 首屏进入设置页、
        乃至 ui.connected 到达后，模型数据一次都没拉过，面板永远停在
        「连接后端后加载提供商…」占位。 */
  function shouldLoadModel() {
    if (currentView() !== 'settings') return false;
    if (location.hash === '#/model') return true;   // 旧链接直达：applyView 会选中该 tab
    const radio = document.getElementById('tab-model');
    return !!(radio && radio.checked);
  }

  function applyView(view) {
    /* 旧链接 #/model 落到设置页时，自动切到「模型」tab，
       否则用户点旧书签会看到「上下文」面板，以为跳错了。 */
    if (view === 'settings' && /^#\/model\b/.test(location.hash || '')) {
      const radio = document.getElementById('tab-model');
      if (radio && !radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    // 视图 section 显隐
    $$('.view-section').forEach((sec) => {
      sec.hidden = sec.dataset.view !== view;
    });
    // companion 是沉浸式全屏视图（在 app-shell 外）：切换时隐藏 shell
    const shell = $('#app-shell');
    if (shell) shell.hidden = view === 'companion';
    // ⚠️ #companion-stage 是 position:fixed; inset:0 的全屏层（index.html 内联样式）。
    // 离开陪伴视图时必须**显式**收起，否则它会一直盖在所有视图上面 ——
    // 实测：切到 #/settings 后整页被它遮成一片白（截图取色 244,244,246，
    // 而 DOM computed 背景是 #111319，两者矛盾正是因为盖了一层）。
    const stage = $('#companion-stage');
    // 对称显隐（2026-10-28 方案A 修复）：进入 companion 必须**显式显示** stage ——
    // 它初始/上次 applyView('chat') 会把 hidden 置 true，旧代码只 hide 不 show ⇒
    // 从 chat 进陪伴时 stage 恒 hidden、沉浸视图全空（backdrop 0×0）。这里改成 hidden = (view!=='companion')。
    if (stage) stage.hidden = view !== 'companion';
    // 导航高亮
    $$('[data-nav-item]').forEach((a) => {
      a.classList.toggle('nav-active', a.dataset.navItem === NAV_BY_VIEW[view]);
    });
    // 确保图标渲染（切换后新显示区域）
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    // 视图数据加载钩子
    // ⚠ 本页正在跑一轮对话时，**不能**重拉历史：loadHistory 会 clearChat()，
    //   把正在流式输出的过程块/交付全部抹掉，只剩磁盘里的旧快照 ——
    //   用户看到的就是「切回来渲染停了，刷新才有」。可见性切换不该触发数据重载 ✓
    // A2：本页不再承担聊天（所有会话在 iframe 内），无需在这里重拉历史
    /* 模型数据现在挂在设置页的「模型」tab 上 ⇒ 进设置时按 tab 状态决定是否拉 */
    if (view === 'settings' && connected && shouldLoadModel()) loadModel();
    if (view === 'sessions' && connected) loadSessions();
    if (view === 'settings' && connected) loadSettings();
    if (view === 'schedule' && connected) loadSchedule();   // 自动化编排视图（automation 域）
    if (view === 'plugins' && connected) loadPlugins();     // 插件视图（内核挂载 + 目录插件管理）
    if (view === 'skills' && connected) loadSkills();       // 技能视图（列表 / 详情 / 启停）
    if (view === 'settings' && connected) loadToolsAndMCP();
    if (view === 'companion' && connected) loadCompanion();
    // 离开陪伴视图：清 live 场景状态（下次进入重新加载）。
    // 场景刷新已改事件驱动 ⇒ 无需停轮询（旧 companionScenePollTimer 已删）
    if (view !== 'companion') {
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
    if (embedMode) wsPostToParent({ type: 'hyacinth:ctx', tokensUsed: used, maxContextTokens: max });
  }

  // 由对话区 iframe 转发的会话上下文数据渲染（父页上下文条 / 缓存命中 / 累计 token）
  function renderHeaderCtx(ctx) {
    const bar = $('#header-context-bar');
    const text = $('#header-context-text');
    const cacheEl = $('#header-cache-text');
    const tokEl = $('#header-tokens-text');
    const c = ctx || {};
    const used = c.tokensUsed != null ? c.tokensUsed : (c.contextTokensUsed != null ? c.contextTokensUsed : null);
    const max = c.maxContextTokens || 0;
    if (bar) bar.style.width = (used != null && max > 0) ? Math.max(0, Math.min(100, (used / max) * 100)) + '%' : '0%';
    if (text) text.textContent = (used != null) ? `${fmtTokens(used)} / ${fmtTokens(max)}` : '— / —';
    let rate = c.cacheHitRate != null ? c.cacheHitRate : c.cacheHitRateAvg;
    if (rate != null) rate = rate <= 1 ? rate * 100 : rate;
    if (cacheEl) cacheEl.textContent = (rate != null) ? `缓存 ${Math.round(rate * 10) / 10}%` : '';
    const ti = c.totalInputTokens; const to = c.totalOutputTokens;
    if (tokEl) tokEl.textContent = (ti != null || to != null) ? `累计 入${fmtTokens(ti || 0)} 出${fmtTokens(to || 0)}` : '';
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
    if (embedMode) wsPostToParent({ type: 'hyacinth:ctx', snap });
  }

  // ════════════════════════════════════════════════════════════
  // chat 视图渲染（message-list 目标：与桌面设计稿气泡样式一致）
  // ════════════════════════════════════════════════════════════
  function clearChat() {
    const ml = $('#message-list');
    if (ml) ml.innerHTML = '';
    histPending = [];
  }

  // 自动跟随：只在用户已贴底(gap<80px)时才滚到底；用户上翻看历史时不打断（2026-10-28 修）
  let _chatStick = true;
  let _chatStickBound = false;
  function scrollChat() {
    const ml = $('#message-list');
    if (!ml) return;
    if (!_chatStickBound) {
      _chatStickBound = true;
      ml.addEventListener('scroll', () => {
        _chatStick = (ml.scrollHeight - ml.scrollTop - ml.clientHeight) < 80;
      }, { passive: true });
    }
    if (_chatStick) ml.scrollTop = ml.scrollHeight;
  }

  function bubbleUser(text, images, timestamp) {
    const wrap = el('div', 'msg msg-user');
    const b = el('div', 'msg-bubble');
    // 图片在前、文字在后：与「先看图再读需求」的阅读顺序一致
    if (images && images.length) {
      const grid = el('div', 'user-attach-grid');
      for (const img of images) {
        const im = document.createElement('img');
        im.className = 'user-attach-img';
        im.src = `data:${img.media_type};base64,${img.data}`;
        im.alt = '附带的图片';
        im.loading = 'lazy';
        grid.appendChild(im);
      }
      b.appendChild(grid);
    }
    if (text) b.appendChild(el('p', 'msg-text', text));
    b.appendChild(el('span', 'msg-time', eventTime(timestamp)));
    wrap.appendChild(b);
    return wrap;
  }

  // ── 交付气泡的「复制原文」────────────────────────────────────────
  /**
   * 复制纯文本。优先 async clipboard（127.0.0.1 属安全上下文 ⇒ 可用 ✓），
   * 非安全上下文或权限被拒时退回 textarea + execCommand。
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 落到兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /**
   * 代码块右上角的「复制」——事件委托挂在 document 上。
   *
   * 为什么不用逐块绑定：代码块是 markdown 动态生成的（流式补渲、历史回放、预览栏，
   * 都可能在你绑完之后再插入新节点），逐块绑必漏。委托只认 `.md-code-copy`，
   * 新出现的块自动生效。
   */
  function bindCodeCopy() {
    document.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.md-code-copy') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const block = btn.closest('.md-code-block');
      const pre = block && block.querySelector('pre');
      if (!pre) return;
      const ok = await copyText(pre.textContent || '');
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('is-copied', ok);
      setTimeout(() => {
        btn.textContent = '复制';
        btn.classList.remove('is-copied');
      }, 1600);
    });
  }

  /**
   * 剪贴板不可用时的退化：选中气泡正文，让用户自己 Ctrl+C。
   * 触发场景：非安全上下文（用 --lan 从别的机器访问 http 页面）或浏览器拒绝授权。
   */
  function selectBubbleText(btn) {
    try {
      const bubble = btn.closest('.msg-bubble');
      const target = bubble && bubble.querySelector('.msg-rich');
      if (!target) return false;
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) { return false; }
  }

  /** 复制按钮：点击后原地反馈「已复制 / 已选中·Ctrl+C / 失败」，约 1.8s 后复位 */
  function makeCopyButton(raw) {
    const icon = (name) => '<i data-lucide="' + name + '" class="w-3.5 h-3.5"></i>';
    const btn = el('button', 'msg-copy');
    btn.type = 'button';
    btn.setAttribute('aria-label', '复制这条交付内容');
    btn.title = '复制原文（markdown）';
    const refreshIcons = () => { if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } } };
    const reset = () => {
      btn.classList.remove('is-copied', 'is-selected', 'is-failed');
      btn.innerHTML = icon('copy');
      refreshIcons();
    };
    btn.innerHTML = icon('copy');
    btn.addEventListener('click', async () => {
      const ok = await copyText(raw);
      // 写剪贴板失败 ⇒ 退化成立即选中正文（不清选区，用户马上就能 Ctrl+C）
      const selected = ok ? false : selectBubbleText(btn);
      btn.classList.toggle('is-copied', ok);
      btn.classList.toggle('is-selected', selected);
      btn.classList.toggle('is-failed', !ok && !selected);
      btn.innerHTML = ok
        ? icon('check') + '<span>已复制</span>'
        : selected
          ? icon('clipboard') + '<span>已选中 · Ctrl+C</span>'
          : icon('x') + '<span>复制失败</span>';
      refreshIcons();
      setTimeout(reset, 1800);
    });
    return btn;
  }

  /**
   * 助手内容块。
   *
   * 设计取向（2026-10-17 按体验调整）：**助手侧不用气泡**。
   *   助手回复的信息量远大于用户提问（表格 / 围栏 / 长列表），气泡的 max-width 与内边距
   *   会把长内容挤窄 ⇒ 改为**全宽文档流**（flex-1 + min-w-0），横向空间全留给正文。
   *   用户消息仍用气泡（短、且需与助手区分）⇒ 纵向节奏变成「右气泡 / 左文档」。
   *
   * opts.delivery = 这是**交付结论**（say 的 content）—— 用两处低成本标记区分：
   *   · 头像换 accent + send 图标
   *   · 左侧 2px primary 细线 + 头行（`交付` 徽章 + 复制按钮）
   *   刻意不整块着色：长回答会被压得很重。
   *
   * 正文包一层 .msg-rich：markdown 块级元素间距靠它收口（首块去上边距、末块去下边距）。
   */
  function bubbleAssistant(text, opts) {
    const delivery = !!(opts && opts.delivery);
    // v3：助手侧不用气泡（长回答 + 表格 + 围栏，气泡会把它挤窄）。
    // 只用「左侧图标轨 + 文档流」区分身份；交付态靠 rail 变色 + 头行文字标记。
    const wrap = el('div', delivery ? 'msg msg-assistant is-delivery' : 'msg msg-assistant');
    const rail = el('div', 'msg-rail');
    rail.innerHTML = delivery
      ? '<i data-lucide="send"></i>'
      : '<i data-lucide="sparkles"></i>';
    const body = el('div', 'msg-body');
    const head = el('div', 'msg-head');
    head.appendChild(el('span', 'msg-who', delivery ? '交付' : 'Hyacinth'));
    head.appendChild(makeCopyButton(text));
    const content = el('div', 'msg-text msg-rich');
    renderRichInto(content, text);
    body.appendChild(head);
    body.appendChild(content);
    body.appendChild(el('span', 'msg-time', eventTime(opts && opts.time)));
    wrap.appendChild(rail);
    wrap.appendChild(body);
    return wrap;
  }

  function bubbleThinking(text) {
    const wrap = el('div', 'msg msg-assistant');
    const rail = el('div', 'msg-rail');
    rail.innerHTML = '<i data-lucide="loader"></i>';
    const body = el('div', 'msg-body');
    body.appendChild(el('div', 'thinking-line', '💭 ' + (text || '思考中…')));
    wrap.appendChild(rail);
    wrap.appendChild(body);
    return wrap;
  }

  /**
   * 工具调用 = **一行卡片**，不是大气泡。
   * 理由：一轮里常有 10+ 次工具调用，每次占一整块会把对话切碎；
   * 结果本身落在「过程」块里（文本），卡片只需要说明"调了什么"。
   */
  function bubbleTool(name, detail) {
    const wrap = el('div', 'tool-card');
    wrap.appendChild(el('span', 'tool-dot'));
    wrap.appendChild(el('span', 'tool-name', name));
    const args = el('span', 'tool-args', detail || '');
    args.title = detail || '';
    wrap.appendChild(args);
    // 参数里像路径 ⇒ 整卡可点，一键在右侧预览栏打开这个文件。
    // 猜错不致命（打开失败会提示），但猜对时省掉"复制路径→去别处翻"这一轮。
    const p = pvPathFromDetail(detail);
    if (p) {
      wrap.classList.add('is-openable');
      wrap.title = '在预览中打开：' + p;
      wrap.tabIndex = 0;
      wrap.onclick = () => pvRevealPath(p);
      wrap.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pvRevealPath(p); }
      };
    }
    return wrap;
  }

  function bubbleSystem(text) {
    return el('div', 'msg-note', text);
  }

  function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * 历史消息时间：优先用事件自带时间戳，缺省才回落到当前时间。
   * 过去统一用 nowTime() ⇒ 打开旧会话每条消息都显示“刚刚/现在”，时间语义全错。
   *
   * 兼容两种格式：
   *   · SessionEvent："2026-10-25 06:18"（本地时间，直接取 HH:MM）
   *   · ConversationEvent：ISO / 带 Z（交给 Date 转本地时间）
   */
  function eventTime(timestamp) {
    if (!timestamp) return nowTime();
    const s = String(timestamp);
    if (/[TZ]/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
    }
    const m = s.match(/(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : nowTime();
  }

  function appendMsg(kind, text, images) {
    const ml = $('#message-list');
    if (!ml) return;
    let node;
    switch (kind) {
      case 'user': node = bubbleUser(text, images); break;
      case 'assistant': node = bubbleAssistant(text); break;
      case 'thinking': node = bubbleThinking(text); break;
      case 'tool': {
        const line = String(text || '');
        const m = line.match(/^(.+?)(?:\(([^)]*)\))?$/);
        node = bubbleTool(m ? m[1] : '工具', m ? m[2] : line);
        break;
      }
      case 'error': { node = bubbleSystem('⚠️ ' + text); node.classList.add('is-error'); break; }
      default: node = bubbleSystem(text); break;
    }
    ml.appendChild(node);
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
    scrollChat();
  }


  // ── 历史渲染（协议 message.history 返回 HistoryMessage[]）──
  // ── 历史回放的「过程缓冲」（与实时路径同一套折叠规则 ✓）──────────────
  // 实测事实（读真实 events.jsonl ✓）：交付正文**没有独立 text 事件**，
  // 它藏在 say 的 tool_call 里（input.content）⇒ 原先一律当折叠小条渲染，
  // 于是刷新后**回复被埋在 JSON 里** ✗ ⇒ 现在认出 say 并单独渲染 ✓
  let histPending = [];   // 延迟渲染：折不折叠取决于「后面有没有交付」✓
  // 「无 say」会话的助手回复是以一串 text 增量事件下发 ⇒ 历史回放需把同一回合的 text
  // 累积成一条助手气泡（否则每个增量成一段碎片、还夹着思考中…，重开就是一团乱）2026-10-28
  let histTurnText = '';

  function histPush(node) { if (node) histPending.push(node); }

  /** 把本回合累积的助手正文作为一条气泡渲染，并收起过程块（无 say 会话的关键修复） */
  function flushHistTurn() {
    if (!histTurnText.trim()) return;
    flushHistoryProcess(true);
    const ml = $('#message-list');
    if (ml) { const dw = bubbleAssistant(histTurnText, { delivery: true }); if (dw) ml.appendChild(dw); }
    histTurnText = '';
  }

  /** 冲刷过程块：collapse=true（后面有交付）⇒ 收起；false ⇒ **保持展开**（不藏正文 ✓） */
  function flushHistoryProcess(collapse) {
    if (!histPending.length) return;
    const ml = $('#message-list');
    if (ml) {
      const det = el('details', 'process-group');
      det.open = false;   // 历史过程块一律收起(2026-10-28)
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
      flushHistTurn();
      flushHistoryProcess(true);
      const dwrap = bubbleAssistant(sayText, { delivery: true, time: m.timestamp });
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
        flushHistTurn();
        flushHistoryProcess(true);
        ml.appendChild(bubbleUser(content, undefined, m.timestamp));
        break;
      case 'text':
      case 'assistant':
        histTurnText += content;
        break;
      case 'thinking':
        // 历史 thinking 多为空内容（渲染成"思考中…"占位、无信息）⇒ 跳过，避免重开满屏「思考中…」(2026-10-28)
        if (content && String(content).trim()) histPush(bubbleThinking(content));
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
      // 50 条只够半轮长任务：末尾的 say 交付经常落在窗口外 ⇒ 刷新后只看到
      // 过程块、看不到回复。取 200 条可覆盖多轮，且 coalesce 后体积仍可控。
      const res = await client.request('message.history', { sessionId: currentSessionId, limit: 200 });
      const msgs = (res && res.messages) || [];
      clearChat();
      if (companionActive) {
        // 陪伴会话的内容只属于陪伴视图：主界面不渲染历史，仅提示去向
        appendMsg('system', '陪伴会话进行中——对话内容请在陪伴模式页查看');
        scrollChat();
        return;
      }
      msgs.forEach(renderHistoryMsg);
      flushHistTurn();
      flushHistoryProcess(true);
      scrollChat();
      // 档位是会话级的：切会话 = 换一套权限状态，这里顺手对齐一次
      //（否则按钮上还写着上个会话的档位，用户会以为"设置丢了"）
      void modeLoad();
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
  /** 过程正文的原始累积文本（渲染前）—— markdown 需要全文才能正确配对围栏 ✓ */
  let processRawText = '';
  let processRenderTimer = null;

  /** 把累积的原始文本渲染成 markdown（节流调用，见 appendProcessText） */
  function renderProcessText() {
    processRenderTimer = null;
    if (processTextNode && processTextNode.isConnected) {
      renderRichInto(processTextNode, processRawText);
    }
  }

  /** 立即冲刷待渲染的过程正文（收起 / 重置前调用，避免丢掉最后一小段 ✓） */
  function flushProcessText() {
    if (processRenderTimer) { clearTimeout(processRenderTimer); processRenderTimer = null; }
    renderProcessText();
  }

  function resetProcessGroup() {
    flushProcessText();
    turnProcessBody = null;
    processTextNode = null;
    processRawText = '';
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
    processRawText = '';
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

  /**
   * 流式文本：累积进「过程」块里的同一条（不是每条事件各起一个气泡 ✓）
   *
   * 走 markdown 而不是 textContent：模型中间叙述里常有 ``` 围栏 / `行内代码` / 列表，
   * 按字面显示会看到一堆反引号 ✗。
   * 但**不能每个 chunk 都重渲染** —— markdown 解析是 O(全文)，一个长回答每秒几十个 chunk
   * 会把长任务的主线程占满。⇒ 累积原文，120ms 节流重渲染一次。
   */
  function appendProcessText(content) {
    if (!content) return;
    if (!processTextNode || !processTextNode.isConnected) {
      processTextNode = el('div', 'process-text msg-rich', '');
      appendProcess(processTextNode);
    }
    processRawText += content;
    if (!processRenderTimer) processRenderTimer = setTimeout(renderProcessText, 120);
    scrollChat();
  }

  /** 收起「过程」块（`say` 交付到达时调用 ✓） */
  function collapseProcessGroup() {
    flushProcessText();      // 收起前先落地最后一段，否则折叠状态下看到的是旧内容 ✗
    const body = turnProcessBody;
    const det = body && body.parentElement;
    if (det && det.tagName === 'DETAILS') det.open = false;
  }

  function handleEvent(type, payload) {
    switch (type) {
      case 'stt.model_progress': {
        // 模型下载进度（语音输入首次使用时触发）：按钮 title 实时反馈。
        // done 后提示"再点一次麦克风重试"—— 原始录音在转写失败时已丢弃，不自动重录。
        const btn = $('#stt-btn');
        if (!btn) return;
        const p = payload || {};
        if (p.phase === 'downloading') {
          btn.title = `语音模型下载中 ${p.percent || 0}%（${p.speed || ''}）`;
          sttBtnSet('transcribing', `正在下载语音模型 ${p.percent || 0}%…`);
          if (currentView() === 'settings') loadVoiceSettings();   // 设置页进度条同步
        } else if (p.phase === 'done') {
          sttState.modelDownloading = false;
          sttBtnSet('idle');
          if (currentView() === 'settings') loadVoiceSettings();
          appendMsg('status', '语音模型下载完成 —— 再点一次麦克风即可语音输入');
        } else if (p.phase === 'error') {
          sttState.modelDownloading = false;
          sttBtnSet('idle');
          if (currentView() === 'settings') loadVoiceSettings();
          appendMsg('error', '语音模型下载失败：' + (p.message || '未知错误'));
        }
        return;
      }
      case 'ui.connected':
        if (payload && payload.sessionId) currentSessionId = payload.sessionId;
        // 刚连上时还不知道这条会话叫什么（session.list 还没回来），先显示「新会话」；
        // 不要在标题里塞 id 片段 —— `5405-505f3d` 对人不构成任何信息。
        setSessionTitle('新会话');
        bindSlashSuggestOnce();   // 斜杠命令建议（只绑一次 ✓）
        connected = true;
        setOnline('connected');
        resetReconnect();
        // 【2026-10-29 修「重启后会话卡运行中」】后端 restart 会打断进行中的回合 ⇒ 那一轮永远
        // 不再来 message.turn_info ⇒ chatBusy 永久 true、新消息只进队列、必须点「终止」才解锁。
        // 重连（ui.connected）即复位 busy（若队列里有消息会被 drain 发出去）。
        setBusy(false);
        loadHistory();
        if (!embedMode) loadSidebarRecent();  // embed 标签没有侧栏：省掉这次列表请求
        // 冷启/重载后无标签时，自动重开上次会话 —— 免手点，也是"重启后继续"能自动触发的关键（2026-10-28）
        if (!embedMode && tabs.length === 0) {
          try {
            const lastSess = localStorage.getItem('hyacinth.lastSession');
            if (lastSess) openSessionInTab(lastSess, '');
          } catch (e) { /* ignore */ }
        }
        // 通知父页"这个标签已就绪、绑定的是哪条会话"（父页据此回填标题/去重）
        wsPostToParent({ type: 'hyacinth:pane-ready', sessionId: currentSessionId });
        // 模型按钮的文案要等 WS 通了才能拉（bindModelPicker 在连接前就跑过一次，
        // 那次必然失败 ⇒ 不补这一下，按钮会一直停在占位符"模型"）
        void modelPickLoad();
        if (shouldLoadModel()) loadModel();
        if (currentView() === 'sessions') loadSessions();
        if (currentView() === 'settings') { loadSettings(); loadToolsAndMCP(); }
        if (currentView() === 'companion') loadCompanion();
        if (currentView() === 'schedule') loadSchedule();   // 定时任务视图（首屏就在该视图时也要加载 ✓）
        if (currentView() === 'plugins') loadPlugins();     // 插件视图
        if (currentView() === 'skills') loadSkills();       // 技能视图（连接建立后补拉）
        refreshState();
        // 同步陪伴模式状态（后端可能因 startup.defaultMode='companion' 已激活）
        // 方案A：embed 标签若绑定的是 companion 会话 ⇒ 必须渲染沉浸视图（applyView 内含 loadCompanion），
        //   否则 companion 的 say 全被挡在看不见的陪伴视图里（"发了没反应"）。
        client.request('companion.get').then((res) => {
          if (res && res.active) {
            companionActive = true;
            companionCharacter = res.character || '';
            updateCompanionButton();
            if (embedMode) applyView('companion');
          }
        }).catch(() => {});
        // 主题真源在后端（ui.theme）：启动时先按 localStorage 缓存应用以避免闪烁，
        // 连上后必须**主动**对齐一次后端值。旧实现只在 loadSettings() 里读它 ⇒
        // localStorage 丢失（清缓存 / 换机器 / 被旧版本回落值污染）时，用户会一直
        // 停在默认深色，直到点开设置页才"突然"变回自己的主题。
        client.request('config.get', { path: 'ui.theme' }).then((r) => {
          const t = r && r.value;
          if (typeof t === 'string' && t) applyTheme(t);
        }).catch(() => {});
        // 启动默认模式：**只问后端**（真源 = config.startup.defaultMode，不再有 localStorage
        // 缓存 —— 那条缓存已整体移除，理由见 bindUI 之前的说明段）。
        // companion → 进陪伴视图（一次性；进入后 loadCompanion 会经协议层激活后端 Router；
        // 用户切走不拉回）。
        // embed 标签永远停在 chat：startup.defaultMode=companion 的跳转只在完整界面里做
        if (!startupModeApplied && !embedMode) {
          startupModeApplied = true;
          client.request('config.get', { path: 'startup.defaultMode' }).then((r) => {
            const mode = (r && r.value) || 'normal';
            if (mode === 'companion' && currentView() === 'chat') goTo('#/companion');
          }).catch(() => {});
        }
        break;
      case 'message.turn_start':
        resetProcessGroup();   // 新回合 ⇒ 「过程」块另起一块 ✓
        wsPostToParent({ type: 'hyacinth:pane-status', sessionId: currentSessionId, running: true });
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
        if (companionActive) break;      // 陪伴会话走 companion.say，不进主界面 ✓
        const sayText = (payload && payload.content) || '';
        if (sayText) {
          const wrap = bubbleAssistant(sayText, { delivery: true });   // 专属样式 ⇒ 一眼看出「这是交付」✓
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
        // 工具级错误通过 isError 标志醒目显示（不触发回合级 message.error，避免误收起过程块）
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
        if (currentView() === 'companion') {
          companionSetDialogue('⚠️ ' + ((payload && payload.message) || '未知错误'));
        } else {
          appendMsg('error', (payload && payload.message) || '未知错误');
        }
        break;
      case 'message.interrupt': {
        showThinking(false);
        // 去重：只有「确实还在 busy」时才算一次有效中断。重复的 interrupt 事件（双击/连点/双发）
        // 此时 chatBusy 已为 false，只复位不再刷「已中断」⇒ 避免一串重复的「已中断」。
        const wasBusy = chatBusy;
        setBusy(false);
        wsPostToParent({ type: 'hyacinth:pane-status', sessionId: currentSessionId, running: false });
        if (wasBusy) {
          if (currentView() === 'companion') {
            companionSetDialogue('⏹ 已中断');
          } else {
            appendMsg('system', '⏹ 已中断');
          }
        }
        break;
      }
      case 'message.flush':
        showThinking(false);
        if (currentView() === 'companion') companionResetDialogue(companionDialogueBuf);
        break;
      case 'message.diff':
        showThinking(false);
        appendDiff(payload);
        break;
      case 'message.turn_info':
        // 回合 token 信息由 state.update 覆盖状态栏
        setBusy(false);
        wsPostToParent({ type: 'hyacinth:pane-status', sessionId: currentSessionId, running: false });
        // A4：一轮结束 updatedAt 才变 ⇒ 只在这里刷一次；流式事件（message.text 等）不刷，
        // 否则每个 chunk 一次 session.list，侧栏刷新成本直接乘上 token 数 ✗
        if (!embedMode) loadSidebarRecent();
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
      case 'session.change': {
        // 协议层在 create / delete / batchDelete 后都会广播这条。
        // ⚠️ 之前只更新 currentSessionId、**不刷新任何列表** ⇒ 在会话管理里删完，
        //    左侧「最近」还是旧的，必须按 F5 才对得上（实测复现）。
        //    delete 的 payload 带 sessionId，batchDelete 带 deleted 数组，两者都可能没有。
        const p = payload || {};
        const act = p.action || '';
        // 只有 switch 的 sessionId 是"新的当前会话"；delete 的 sessionId 是**被删的**那个，
        // 拿它覆盖 currentSessionId 等于把指针指向一个已不存在的目录（原实现的隐患）。
        if (act === 'switch' && p.sessionId) currentSessionId = p.sessionId;
        if (act === 'create' || act === 'delete' || act === 'batchDelete') {
          void loadSidebarRecent();
          if (currentView() === 'sessions') void loadSessions();
        }
        break;
      }
      case 'model.change':
        refreshState();
        // 输入框旁的模型按钮与顶栏 chip 必须同源：TUI 或另一个窗口切了模型，这里跟着变
        void modelPickLoad();
        if (shouldLoadModel()) loadModel();
        break;
      case 'config.change':
        if (currentView() === 'settings') loadSettings();
        break;
      case 'companion.voice':
        handleCompanionVoice(payload);
        break;
      case 'tts.say_voice':
        handleSayVoice(payload);
        break;
      case 'companion.scene':
        // 场景图更新推送：后端监视 scene.json 落盘后广播 ⇒ 即时刷新，无需轮询
        // （此前是每 15s 拉一次 companion.scene，最多迟 15 秒才换背景）
        loadCompanionScene();
        break;
      case 'permission.request':
        showPermission(payload);
        break;
      case 'ui.error': {
        showThinking(false);
        const p = payload || {};
        appendMsg('error', p.message || '后端错误');
        if (embedMode) {
          // 标签失败原因回报父页（标签标题/状态点显示）；终端错误（会话不存在 / 被占用）
          // 还要停掉自动重连 —— 否则每 1~10s 重试一次，永远连不上也永远在刷屏。
          wsPostToParent({ type: 'hyacinth:pane-error', code: p.code || '', message: p.message || '' });
          if (p.code === 'SESSION_IN_USE' || p.code === 'SESSION_NOT_FOUND' || p.code === 'INVALID_SESSION') {
            client.closed = true;
            if (client.reconnectTimer) { clearTimeout(client.reconnectTimer); client.reconnectTimer = null; }
            try { if (client.ws) client.ws.close(); } catch (e) { /* ignore */ }
            if (p.code === 'SESSION_IN_USE') appendMsg('system', '这条会话已在另一个标签中打开。请切到那个标签，或先关闭它。');
          }
        }
        break;
      }
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
    avatar.innerHTML = '<i data-lucide="file-diff" class="w-4 h-4 text-muted-foreground"></i>';
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
  // 队列而非单变量：并发工具会同时排入多个权限请求；单变量会被后到的"顶掉"，
  // 先到的请求永远等不到应答 ⇒ 该轮工具执行卡死 ✗
  const permissionQueue = [];

  function showPermission(payload) {
    if (!payload) return;
    permissionQueue.push(payload);
    renderPermissionHead();
  }

  function renderPermissionHead() {
    const d = $('#permission-dialog');
    const head = permissionQueue[0];
    if (!head) { if (d) d.hidden = true; return; }
    const t = $('#permission-text');
    if (t) {
      const more = permissionQueue.length > 1 ? `（另有 ${permissionQueue.length - 1} 项待处理）` : '';
      t.textContent = `${head.toolName} 请求执行权限${more}`;
    }
    if (d) d.hidden = false;
  }

  function resolvePermission(result) {
    const head = permissionQueue.shift();
    if (!head) return;
    // aor = 解除全部限制 ⇒ 队列里其余一并放行（与 TUI 端同语义）
    const batched = result === 'aor' ? permissionQueue.splice(0) : [];
    client.request('permission.resolve', { id: head.id, result }).catch(() => {});
    for (const p of batched) {
      client.request('permission.resolve', { id: p.id, result }).catch(() => {});
    }
    renderPermissionHead();
  }

  // ── ask_user 对话框（message.ask_user → askUserResolve）──
  let pendingAsk = null;

  function showAskUser(payload) {
    if (!payload || !payload.questions) return;
    pendingAsk = payload;
    const box = $('#askuser-questions');
    if (!box) return;
    box.innerHTML = '';
    const n = payload.questions.length;
    const head = el('div', 'au-head');
    head.appendChild(el('span', 'au-page', n > 1 ? ('1 / ' + n) : '1 / 1'));
    const close = el('button', 'au-close', '✕');
    close.type = 'button';
    close.addEventListener('click', () => { const d = $('#askuser-dialog'); if (d) d.hidden = true; pendingAsk = null; });
    head.appendChild(close);
    box.appendChild(head);
    (payload.questions || []).forEach((q, i) => {
      const field = el('div', 'ask-field');
      field.dataset.qi = String(i);
      field.appendChild(el('div', 'ask-q', q.question));
      const opts = el('div', 'ask-opts');
      (q.options || []).forEach((o, oi) => {
        const row = el('div', 'ask-opt');
        row.dataset.val = o;
        row.appendChild(el('span', 'ask-idx', String(oi + 1)));
        row.appendChild(el('span', 'ask-opt-txt', o));
        row.appendChild(el('span', 'au-arrow', '›'));
        row.addEventListener('click', () => {
          if (q.multiSelect) {
            row.classList.toggle('is-sel');
          } else {
            opts.querySelectorAll('.ask-opt').forEach((x) => x.classList.remove('is-sel'));
            row.classList.add('is-sel');
          }
        });
        opts.appendChild(row);
      });
      if ((q.options || []).length) field.appendChild(opts);
      if (q.customInput !== false) {
        const wrap = el('div', 'au-custom');
        wrap.appendChild(el('span', 'au-pencil', '✎'));
        const input = el('input');
        input.type = 'text';
        input.placeholder = '其他补充…';
        wrap.appendChild(input);
        field.appendChild(wrap);
      }
      box.appendChild(field);
    });
    const d = $('#askuser-dialog');
    if (d) d.hidden = false;
  }

  function resolveAskUser() {
    if (!pendingAsk) return;
    const { id, questions } = pendingAsk;
    const fields = $$('#askuser-questions .ask-field'); // ⚠️ 必须 $$（数组）：用 $ 只取首个元素 ⇒ fields[i] 恒 undefined ⇒ result 恒空（2026-10-28 修 ask_user 提交空答案 bug）
    const result = {};
    (questions || []).forEach((q, i) => {
      const field = fields[i];
      if (!field) return;
      const answers = [];
      field.querySelectorAll('.ask-opt.is-sel').forEach((x) => { if (x.dataset.val) answers.push(x.dataset.val); });
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

  // ── 发送/停止按钮状态 + 消息队列（忙碌时入队，回合结束自动发下一条）──
  let chatBusy = false;
  /** 前端发送队列：忙碌时发送的消息先入队（不硬插进对话），回合结束逐条发。item={id,text,images} */
  const sendQueue = [];
  function setBusy(busy) {
    chatBusy = !!busy;
    const send = $('#chat-send-btn');
    const stop = $('#chat-stop-btn');
    if (send) send.hidden = busy;
    if (stop) stop.hidden = !busy;
    if (!busy) drainSendQueue(); // 回合结束 → 尝试发下一条排队消息
  }

  /** 真正发送一条消息（原 sendChat 的发送主体：回显用户 + 斜杠分流 + message.chat） */
  function dispatchChat(text, images) {
    images = images || [];
    appendMsg('user', text, images);
    if (!connected) { appendMsg('error', '尚未连接后端，无法发送'); return; }
    if (!images.length && text.startsWith('/')) {
      if (cmdDropdown) cmdDropdown.hidden = true;
      runSlashCommand(text);
      return;
    }
    setBusy(true);
    const content = text || '请看这张图。';
    const payload = images.length ? { content, images } : { content };
    client.request('message.chat', payload).catch((e) => {
      setBusy(false);
      appendMsg('error', `发送失败: ${(e && e.message) || '未知错误'}`);
    });
  }

  /** 忙碌时入队（不立刻发，渲染到输入框上方队列面板） */
  function enqueueSend(text, images) {
    sendQueue.push({ id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6), text, images: images || [] });
    renderQueuePanel();
  }

  /** 回合结束：当前不忙且队列非空 ⇒ 发队首 */
  function drainSendQueue() {
    if (chatBusy || !sendQueue.length) return;
    const item = sendQueue.shift();
    renderQueuePanel();
    dispatchChat(item.text, item.images);
  }

  /** 渲染输入框上方的队列面板（每条：拖动柄/文本 + 立即发送/编辑/删除） */
  function renderQueuePanel() {
    const box = $('#composer-queue');
    if (!box) return;
    if (!sendQueue.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '';
    sendQueue.forEach((item) => {
      const row = el('div', 'queue-item');
      row.dataset.id = item.id;
      row.appendChild(el('span', 'queue-handle', '⋮⋮'));
      if (item.images && item.images.length) row.appendChild(el('span', 'queue-thumb', '🖼' + item.images.length));
      const txt = el('span', 'queue-text', item.text || '（图片）');
      txt.title = item.text || '';
      row.appendChild(txt);
      const acts = el('div', 'queue-acts');
      const mk = (cls, icon, title, fn) => {
        const b = el('button', 'queue-btn ' + cls); b.type = 'button'; b.title = title; b.innerHTML = icon;
        b.addEventListener('click', fn); return b;
      };
      acts.appendChild(mk('queue-sendnow', '↑', '立即发送（打断当前回合并优先发送）', () => queueSendNow(item.id)));
      acts.appendChild(mk('queue-edit', '✎', '编辑', () => queueEdit(item.id, row, txt)));
      acts.appendChild(mk('queue-del', '✕', '删除', () => queueDelete(item.id)));
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  function queueDelete(id) {
    const i = sendQueue.findIndex((x) => x.id === id);
    if (i >= 0) sendQueue.splice(i, 1);
    renderQueuePanel();
  }

  function queueEdit(id, row, txtEl) {
    const item = sendQueue.find((x) => x.id === id);
    if (!item || row.querySelector('input.queue-edit-input')) return;
    const inp = el('input', 'queue-edit-input'); inp.type = 'text'; inp.value = item.text;
    txtEl.replaceWith(inp);
    inp.focus();
    const save = () => { item.text = inp.value.trim() || item.text; renderQueuePanel(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { renderQueuePanel(); } });
    inp.addEventListener('blur', save);
  }

  function queueSendNow(id) {
    const i = sendQueue.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [item] = sendQueue.splice(i, 1);
    sendQueue.unshift(item); // 提到队首
    renderQueuePanel();
    if (chatBusy) {
      // 打断当前回合 → message.stop → 之后 setBusy(false) 自动 drain 队首（即本条）
      client.request('message.stop').catch(() => {});
    } else {
      drainSendQueue();
    }
  }

  async function refreshState() {
    try {
      // state.subscribe（而非 state.get）：语义是"订阅 + 立刻回传当前快照"。
      // 请求即登记订阅意图，后续靠 state.update 事件持续刷新，无需轮询。
      const res = await client.request('state.subscribe');
      if (res && res.snapshot) updateHeader(res.snapshot);
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
  // 六档（含 off）：与 index.html 的 radio 一一对应，也与上游 reasoning_effort 的
  // 取值集合对齐（minimal/low/medium/high/max）。
  const REASONING_DESC = {
    off: '完全关闭思考，响应最快；适合纯检索、格式转换这类不需要推理的任务。',
    minimal: '极低强度，只做必要的前置判断。',
    low: '低强度优先响应速度，适合简单问答与短任务。',
    medium: '中等强度在响应速度与复杂推理之间取得平衡。',
    high: '高强度投入更多推理步骤，适合复杂代码与深度分析。',
    max: '最高强度，允许模型长时间自检；慢，但适合难题与多步规划。',
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
      // 档位回显：radio 默认 checked 写死在 HTML 里（medium），与实际生效值可能不一致
      // （模型目录里 deepseek-flash 的默认是 high）。这里按输入框旁那个选择器的最新状态对齐。
      $$('input[name="reasoning"]').forEach((r) => { r.checked = r.value === modelPick.effort; });
      const rDesc = $('#model-reasoning-desc');
      if (rDesc && REASONING_DESC[modelPick.effort]) rDesc.textContent = REASONING_DESC[modelPick.effort];
    } catch (e) {
      /* ⚠️ 原来是静默 ignore。实测代价（2026-10-27）：模型面板并入设置页后数据全空
         （当前模型「—」、提供商只剩「连接后端后加载提供商…」、通道 0 行），而 RPC 本身
         是通的（手动 model.listProviders 成功）⇒ 渲染环节抛的错被这里吃掉，页面看起来
         "只是没数据"。catch 必须留日志。 */
      console.error('[model] loadModel 失败:', (e && (e.message || e.code)) || e);
    }
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
   * 模型目录缓存 —— 通道「改模型」的下拉选项数据源（与输入框旁的模型选择器同一份）。
   *
   * 为什么要缓存：每个通道行都可能展开一次改模型表单，逐个请求 58 条目录很浪费；
   * 目录本身在一次会话里几乎不变（除非重启服务）。
   */
  let modelCatalogCache = null;
  async function ensureModelCatalog() {
    if (modelCatalogCache && modelCatalogCache.length) return modelCatalogCache;
    const r = await client.request('model.listModels').catch(() => null);
    modelCatalogCache = (r && r.models) || [];
    return modelCatalogCache;
  }

  /**
   * 通道行操作 —— 接 model.setChannelModel / resetChannelModel / removeChannel ✓
   * 「改模型」是**行内表单**（点一下在本行展开两个下拉 ✓），不是弹窗、不是手填。
   * ⚠️ 刻意不用 window.prompt ✗：无头探针遇到原生对话框会卡住 ✓
   * ⚠️ 原来是两个文本框，用户得自己记住 `provider` 和 `model` 的拼写 —— 拼错要到
   *    "切换失败"才知道。目录里已经有全部厂商/模型，没有理由让人手打。
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

    // ── 改模型：行内表单（厂商下拉 + 模型下拉，联动）──
    const editBtn = mkBtn('改模型', '修改该通道的提供商/模型（写入配置文件，重启后仍生效）');
    editBtn.onclick = async () => {
      // 再点一次 = 收起。编辑区挂在**本行下方**（独占整行），不挤在窄窄的操作列里 ——
      // 操作列只有按钮那么宽，两个下拉塞进去会往左压到"提供商"列上。
      const open = row.nextElementSibling;
      if (open && open.classList.contains('chan-edit-row')) { open.remove(); return; }

      const models = await ensureModelCatalog();
      const selCls = 'text-[11px] px-2 py-1 rounded-md border border-border bg-background text-foreground';

      // 厂商列表：目录里去重 + 保序；当前厂商若不在目录里（本地 / 自定义）补到最前，
      // 否则一展开下拉就会"选中的是别人"
      const provs = [...new Set(models.map((m) => m.provider))].sort();
      const curProv = c.provider || provs[0] || '';
      if (curProv && !provs.includes(curProv)) provs.unshift(curProv);

      const pSel = document.createElement('select');
      pSel.className = selCls + ' w-32';
      pSel.title = '提供商';
      pSel.setAttribute('aria-label', '提供商');
      provs.forEach((p) => {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        pSel.appendChild(o);
      });
      if (curProv) pSel.value = curProv;

      const mSel = document.createElement('select');
      mSel.className = selCls + ' w-56';
      mSel.title = '模型';
      mSel.setAttribute('aria-label', '模型');

      // 通道里存的 model 可能是历史写法（带厂商前缀，如 deepseek/deepseek-v4.1-flash）
      const curModel = String(c.model || '');
      const curBare = curModel.includes('/') ? curModel.split('/').pop() : curModel;

      const fillModels = () => {
        const list = models.filter((m) => m.provider === pSel.value);
        mSel.innerHTML = '';
        if (!list.length) {
          const o = document.createElement('option');
          o.value = '';
          o.textContent = '（使用该厂商默认模型）';
          mSel.appendChild(o);
          return;
        }
        list.forEach((m) => {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = m.name;
          mSel.appendChild(o);
        });
        // 当前值不在目录里（自定义模型 / 已下线）⇒ 补一条"当前"选项并选中，
        // 这样点"确定"等于什么都没改，而不是悄悄换成列表第一个
        const hit = list.find((m) => m.id === curModel || m.id === curBare);
        if (!hit && curModel && pSel.value === curProv) {
          const o = document.createElement('option');
          o.value = curModel;
          o.textContent = curModel + '（当前，未在目录中）';
          mSel.appendChild(o);
          mSel.value = curModel;
        } else if (hit) {
          mSel.value = hit.id;
        }
      };
      fillModels();
      pSel.onchange = fillModels;

      const ok = mkBtn('确定');
      const cancel = mkBtn('取消');

      const editRow = el('div', 'chan-edit-row');
      editRow.appendChild(el('span', 'chan-edit-label', c.name));
      editRow.appendChild(pSel);
      editRow.appendChild(mSel);
      editRow.appendChild(ok);
      editRow.appendChild(cancel);
      row.after(editRow);

      cancel.onclick = () => editRow.remove();
      ok.onclick = () => {
        if (!connected) { editRow.remove(); return; }
        const provider = pSel.value;
        if (!provider) return;
        ok.disabled = true;
        client.request('model.setChannelModel', {
          name: c.name,
          provider,
          model: mSel.value || undefined,
        })
          .then(() => { editRow.remove(); appendMsg('system', '通道 ' + c.name + ' 已切换模型'); loadModel(); })
          .catch((e) => { ok.disabled = false; appendMsg('error', '切换失败: ' + (e && e.message)); });
      };
    };
    ops.appendChild(editBtn);

    // ── 复位：丢弃临时改动，回到持久化配置 ✓
    const rsBtn = mkBtn('复位', '从配置文件重读该通道设置（丢弃未落盘的临时改动）');
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
        // 'off' 是"关闭思考"这一档（enabled:false，不发 reasoning_effort）；
        // 其余五档都是开启 + 具体强度 —— 以前把 low 当关闭，导致"低"发出去的是 disabled。
        const enabled = r.value !== 'off';
        client.request('model.setThinking', { enabled, effort: enabled ? r.value : undefined }).catch(() => {});
        // 输入框旁的模型选择器里也有同一组档位：两处共用一个状态，切换要互相看得见
        syncThinkingUI(r.value);
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
  // ── 斜杠命令（接 command.list / command.execute ✓ 2026-09-20）──────────
  // 此前 `command` **整域闲置** ✗ ⇒ 网页里打 `/命令` 只会被当成普通消息发给模型 ✗
  // 协议语义（读 command.ts 得到 ✓）：
  //   · 纯 UI 命令（clear/help/exit/restart/new）**协议层不执行** ⇒ 回 `ui-only` ⇒ 前端本地处理 ✓
  //   · 后端命令 ⇒ 委托执行；未接入则回 `backend-not-wired` ✓
  let commandCache = null;      // command.list 结果（进程内缓存 ⇒ 只拉一次 ✓）
  let cmdDropdown = null;
  let slashBound = false;

  async function getCommands() {
    if (commandCache) return commandCache;
    try {
      const res = await client.request('command.list');
      commandCache = (res && res.categories) || [];
    } catch (e) { commandCache = []; }
    return commandCache;
  }

  /** 分类树 → 扁平清单（含 `父/子` 路径 ✓） */
  function flattenCommands(cats) {
    const out = [];
    const walk = (cmds, prefix) => {
      (cmds || []).forEach((c) => {
        const full = prefix ? prefix + '/' + c.name : c.name;
        out.push({ name: full, leaf: c.name, description: c.description || '', args: c.args || '' });
        if (c.children && c.children.length) walk(c.children, full);
      });
    };
    (cats || []).forEach((cat) => walk(cat.commands, ''));
    return out;
  }

  /** 建议下拉容器：挂在输入框所在容器上（绝对定位在输入框上方 ✓） */
  function ensureCmdDropdown() {
    if (cmdDropdown && cmdDropdown.isConnected) return cmdDropdown;
    const host = $('#chat-composer');
    if (!host) return null;
    host.style.position = 'relative';
    cmdDropdown = el('div', 'absolute left-2 right-2 bottom-full mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-card shadow-lg z-20');
    cmdDropdown.hidden = true;
    host.appendChild(cmdDropdown);
    return cmdDropdown;
  }

  /** 输入变化 → 刷新建议（只在以 / 开头时显示 ✓） */
  async function updateCmdSuggest() {
    const input = $('#chat-input');
    const box = ensureCmdDropdown();
    if (!input || !box) return;
    const v = input.value;
    if (!v.startsWith('/')) { box.hidden = true; box.innerHTML = ''; return; }
    const q = v.slice(1).toLowerCase();
    const all = flattenCommands(await getCommands());
    const hits = all.filter((c) => !q || c.leaf.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q)).slice(0, 12);
    box.innerHTML = '';
    if (!hits.length) {
      box.appendChild(el('div', 'px-3 py-2 text-xs text-muted-foreground', '没有匹配的命令'));
    } else {
      hits.forEach((c) => {
        const row = el('button', 'w-full text-left px-3 py-2 text-xs hover:bg-muted flex items-center gap-2');
        row.appendChild(el('span', 'font-mono text-foreground', '/' + c.name));
        if (c.args) row.appendChild(el('span', 'text-muted-foreground', c.args));
        row.appendChild(el('span', 'ml-auto text-[10px] text-muted-foreground truncate max-w-[45%]', c.description));
        row.onclick = () => { input.value = '/' + c.name + ' '; input.focus(); box.hidden = true; };
        box.appendChild(row);
      });
    }
    box.hidden = false;
  }

  /** 绑定建议交互（只需一次 ✓；由 ui.connected 触发 ⇒ DOM 必已就绪 ✓） */
  function bindSlashSuggestOnce() {
    if (slashBound) return;
    const input = $('#chat-input');
    if (!input) return;
    slashBound = true;
    input.addEventListener('input', () => { updateCmdSuggest().catch(() => { /* ignore */ }); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cmdDropdown) { cmdDropdown.hidden = true; }
    });
  }

  /** 纯 UI 命令的本地处理（协议层不执行这些 ⇒ 别发过去 ✓） */
  function handleLocalCommand(leaf) {
    if (leaf === 'clear') { clearChat(); appendMsg('system', '已清空当前视图（历史仍保留在会话里）'); return; }
    if (leaf === 'help') {
      appendMsg('system', '可用命令（输入 / 开头即可筛选）：');
      getCommands().then((cats) => {
        flattenCommands(cats).slice(0, 40).forEach((c) => {
          appendMsg('system', '  /' + c.name + (c.args ? ' ' + c.args : '') + (c.description ? '  —— ' + c.description : ''));
        });
      }).catch(() => { /* ignore */ });
      return;
    }
    if (leaf === 'new') {
      // 空会话 = 一条**不带 session 参数**的连接：后端自铸 id + lazySession
      // ⇒ 只登记、不建目录；首条消息到达时 loop.materializeSessionIfNeeded() 才落盘。
      // 前端**不向后端索要 id**（lazy 会话不在 session.list 里，带 ?session= 会被拒）。
      openSessionInTab(null, '已新建空会话（发出第一条消息后才会保存）');
      return;
    }
    appendMsg('system', '「/' + leaf + '」请在终端（TUI）里使用 ✓');
  }

  /** 执行斜杠命令（返回 true 表示已接管，不再走 message.chat ✓） */
  function runSlashCommand(raw) {
    const m = /^\/([^\s]+)\s*([\s\S]*)$/.exec(raw);
    if (!m) return false;
    const name = m[1];
    const args = (m[2] || '').trim();
    const leaf = name.split('/').pop();
    // ① 纯 UI 命令 ⇒ 本地处理（协议层会回 ui-only ⇒ 发了也白搭 ✓）
    // ① 有对应页面的命令 ⇒ **直接跳过去**（用户指出：Web 有交互，不该学终端把结果打在聊天里 ✗）
    const COMMAND_TO_VIEW = { schedule: 'schedule', model: 'model', sessions: 'sessions', settings: 'settings', companion: 'companion' };
    if (COMMAND_TO_VIEW[leaf] && !args) {
      location.hash = '#/' + COMMAND_TO_VIEW[leaf];
      appendMsg('system', '已跳转到「' + leaf + '」页面 ✓');
      return true;
    }
    if (leaf === 'clear' || leaf === 'help' || leaf === 'new' || leaf === 'exit' || leaf === 'restart') {
      handleLocalCommand(leaf);
      return true;
    }
    // ② 后端命令 ⇒ 交给协议层 ✓
    if (!connected) { appendMsg('error', '尚未连接后端，无法执行命令'); return true; }
    setBusy(true);
    client.request('command.execute', { name, args })
      .then((res) => {
        setBusy(false);
        if (res && res.unsupported) {
          const why = res.reason === 'backend-not-wired' ? '（该命令后端未接入）' : '（该命令由界面本地处理）';
          appendMsg('system', '/' + name + ' ' + why);
          return;
        }
        if (res && res.ok === false) {
          appendMsg('error', '/' + name + ' 失败: ' + (res.reason || '未知原因'));
          return;
        }
        const out = res && res.result !== undefined ? res.result : res;
        let text = '';
        try { text = typeof out === 'string' ? out : JSON.stringify(out, null, 2); } catch (e) { text = String(out); }
        appendMsg('system', '/' + name + ' ⇒ ' + (text.length > 1200 ? text.slice(0, 1200) + ' …' : text));
        // 命令可能改变配置/模型/会话 ⇒ 顺手刷新一次状态 ✓
        refreshState();
        if (shouldLoadModel()) loadModel();
        if (currentView() === 'sessions') loadSessions();
        if (currentView() === 'settings') loadSettings();
      })
      .catch((e) => { setBusy(false); appendMsg('error', '命令执行失败: ' + (e && e.message)); });
    return true;
  }

  // ── 自动化编排视图（automation 域；2026-10-30 重做）────────────────────
  // 从「定时任务」升级为「自动化链路」：触发(When) × 动作链(do: invoke 工具/参数、gate、wake)。
  // 核心价值是 invoke 零模型跑工具，schedule 域表达不了，故走独立的 automation 域。
  let scheduleBound = false;
  /** 删除采用"两段点击"确认 —— 刻意不用 window.confirm ✗（无头探针遇原生对话框会卡 ✓） */
  let schedulePendingDelete = null;

  // 起点 = 触发(when) 的节点描述
  function whenParts(w) {
    if (!w) return { icon: '?', primary: '未知', detail: '' };
    if (w.kind === 'time') {
      const s = w.schedule || {};
      let d = '';
      if (s.intervalMs) {
        const ms = Number(s.intervalMs);
        d = ms < 60000 ? '每 ' + Math.round(ms / 1000) + ' 秒' : '每 ' + Math.round(ms / 60000) + ' 分钟';
      }
      else if (s.time) d = '每天 ' + s.time;
      else if (s.expression) d = 'cron ' + s.expression;
      else if (s.runAt) d = '单次 ' + String(s.runAt);
      else d = JSON.stringify(s);
      return { icon: '⏰', primary: '定时', detail: d };
    }
    if (w.kind === 'probe') {
      const kindMap = { file: '文件', http: '接口', process: '进程', port: '端口', ui_region: '画面' };
      const k = kindMap[w.probe && w.probe.kind] || (w.probe && w.probe.kind) || '条件';
      const sp = (w.probe && w.probe.spec) || {};
      const detail = sp.path || sp.url || sp.name || (sp.port ? ':' + sp.port : '') || '';
      const exp = sp.expect ? '→' + sp.expect : '';
      return { icon: '👁', primary: k, detail: (detail + (exp ? ' ' + exp : '')).trim() };
    }
    if (w.kind === 'event') return { icon: '⚡', primary: '事件', detail: w.event || '' };
    return { icon: '?', primary: w.kind || '未知', detail: '' };
  }

  // 过程 = 单个动作(do[i]) 的节点描述
  function actionParts(a) {
    if (!a) return { icon: '?', primary: '动作', detail: '' };
    if (a.sink === 'invoke') return { icon: '⚙', primary: 'invoke', detail: a.tool || '?' };
    if (a.sink === 'wake') return { icon: '💬', primary: 'wake', detail: (a.where && a.where.policy) || '?' };
    if (a.sink === 'gate') return { icon: '⑂', primary: 'gate', detail: '条件分支' };
    if (a.sink === 'append') return { icon: '📝', primary: 'append', detail: a.to || '' };
    if (a.sink === 'safety') return { icon: '🛡', primary: 'safety', detail: '' };
    if (a.sink === 'loop') {
      // 循环节点：主名显示终止条件，detail 显示循环体动作摘要（→ 让"内部循环"可读）
      const body = Array.isArray(a.do) ? a.do : [];
      const term = a.times !== undefined ? '×' + a.times
        : a.until ? 'until'
        : a.while ? 'while'
        : '循环';
      const inner = body.map((b) => b.sink === 'invoke' ? (b.tool || 'invoke') : (b.sink || '?')).join(', ');
      return { icon: '🔁', primary: 'loop ' + term, detail: body.length + '步: ' + inner };
    }
    return { icon: '•', primary: a.sink || '?', detail: '' };
  }

  // 一个节点模块：kind = start(起点) | mid(过程) | end(终点)
  function chainNode(kind, parts) {
    const styleMap = {
      start: { bc: 'var(--hyacinth-primary)', bg: 'var(--primary-100, rgba(99,102,241,0.10))', label: '起点' },
      mid: { bc: 'var(--hyacinth-border)', bg: 'var(--hyacinth-muted)', label: '过程' },
      end: { bc: 'var(--state-success)', bg: 'rgba(34,197,94,0.10)', label: '终点' },
    };
    const st = styleMap[kind] || styleMap.mid;
    const box = el('div', 'inline-flex flex-col gap-0.5 px-3 py-2 rounded-lg border text-xs min-w-[104px] max-w-[230px] shrink-0');
    box.style.borderColor = st.bc;
    box.style.backgroundColor = st.bg;
    box.appendChild(el('div', 'text-[9px] uppercase tracking-widest text-muted-foreground leading-none', st.label));
    box.appendChild(el('div', 'font-medium text-foreground leading-tight truncate', (parts.icon ? parts.icon + ' ' : '') + parts.primary));
    if (parts.detail) box.appendChild(el('div', 'text-[10px] text-muted-foreground font-mono leading-tight truncate', parts.detail));
    box.title = ((parts.icon ? parts.icon + ' ' : '') + parts.primary) + (parts.detail ? ' · ' + parts.detail : '');
    return box;
  }

  function chainArrow() {
    return el('span', 'text-muted-foreground text-sm select-none shrink-0', '→');
  }

  function automationRow(r) {
    const card = el('div', 'bg-card border border-border rounded-lg px-4 py-3 flex flex-col gap-2.5');
    // 头部：名称 + 启用 + 删除
    const head = el('div', 'flex items-center gap-3');
    head.appendChild(el('div', 'text-sm font-medium text-foreground flex-1 min-w-0 truncate', r.name || r.id));
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.checked = !!r.enabled;
    sw.className = 'w-3.5 h-3.5 accent-[var(--hyacinth-primary)] shrink-0 cursor-pointer';
    sw.title = r.enabled ? '已启用（点击停用）' : '已停用（点击启用）';
    sw.onchange = () => {
      if (!connected) { sw.checked = !sw.checked; return; }
      sw.disabled = true;
      client.request('automation.toggle', { id: r.id, enabled: sw.checked })
        .then(() => { appendMsg('system', '规则「' + (r.name || r.id) + '」已' + (sw.checked ? '启用' : '停用')); loadSchedule(); })
        .catch((e) => { sw.checked = !sw.checked; sw.disabled = false; appendMsg('error', '切换失败: ' + (e && e.message)); });
    };
    head.appendChild(sw);
    const del = el('button', 'text-[11px] px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors shrink-0', '删除');
    del.style.color = 'var(--state-error)';
    del.onclick = () => {
      if (!connected) return;
      if (schedulePendingDelete !== r.id) {
        schedulePendingDelete = r.id;
        del.textContent = '再点一次确认';
        setTimeout(() => { if (schedulePendingDelete === r.id) { schedulePendingDelete = null; del.textContent = '删除'; } }, 4000);
        return;
      }
      schedulePendingDelete = null;
      del.disabled = true;
      client.request('automation.remove', { id: r.id })
        .then((res) => { appendMsg('system', (res && res.ok) ? '规则「' + (r.name || r.id) + '」已删除' : '删除未生效'); loadSchedule(); })
        .catch((e) => { del.disabled = false; appendMsg('error', '删除失败: ' + (e && e.message)); });
    };
    head.appendChild(del);
    card.appendChild(head);

    // 节点流：起点(触发) → 过程(动作链每个动作) → 终点(完成)
    const flow = el('div', 'flex flex-wrap items-center gap-2 pb-1');
    flow.appendChild(chainNode('start', whenParts(r.when)));
    const actions = Array.isArray(r.do) ? r.do : [];
    for (const a of actions) {
      flow.appendChild(chainArrow());
      flow.appendChild(chainNode('mid', actionParts(a)));
    }
    flow.appendChild(chainArrow());
    flow.appendChild(chainNode('end', { icon: '🏁', primary: '完成', detail: '' }));
    card.appendChild(flow);
    // maxRuns 进度：达到上限后规则会自动停用，这里把「已跑 / 上限」显出来
    if (typeof r.maxRuns === 'number' && r.maxRuns > 0) {
      const runN = typeof r.runCount === 'number' ? r.runCount : 0;
      const done = runN >= r.maxRuns;
      const line = el('div', 'text-[11px] ' + (done ? 'text-state-error' : 'text-muted-foreground'), '已触发 ' + runN + ' / ' + r.maxRuns + ' 次' + (done ? '（已达上限，已停用）' : '后自动停用'));
      card.appendChild(line);
    }
    return card;
  }

  async function loadSchedule() {
    const listEl = $('#automation-list');
    if (!listEl) return;
    bindScheduleOnce();
    let data = null;
    try { data = await client.request('automation.list'); } catch (e) { data = null; }
    if (!data) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'text-sm text-state-error', '取不到自动化规则（后端可能未就绪）'));
      return;
    }
    const rules = data.rules || [];
    const statusEl = $('#automation-status');
    if (statusEl) {
      const enabled = rules.filter((r) => r.enabled).length;
      statusEl.textContent = '触发 → 动作链，零模型按图执行 · 已启用 ' + enabled + '/' + rules.length + ' 条规则';
    }
    listEl.innerHTML = '';
    if (!rules.length) {
      listEl.appendChild(el('div', 'text-sm text-muted-foreground', '还没有自动化规则。上面填规则名 + 触发条件 + 要调用的工具，点「添加规则」。'));
      return;
    }
    rules.forEach((r) => listEl.appendChild(automationRow(r)));
  }

  // ── 定时任务视图（schedule 域；add_task 建的任务，走 HeartbeatScheduler）──
  // 与「自动化」页的分工：这里是 scheduler 的任务（有 cron/持久化/补执行/执行记录），
  // 「自动化」页是 automation 的链路（零模型/分支/循环）。两者后端不同、互不影响。
  const TASK_TYPE_LABEL = { interval: '间隔', cron: 'cron', daily: '每天', 'fixed-time': '单次', random: '随机' };
  function taskRow(t) {
    const card = el('div', 'bg-card border border-border rounded-lg px-4 py-3 flex flex-col gap-2');
    const head = el('div', 'flex items-center gap-3');
    head.appendChild(el('div', 'text-sm font-medium text-foreground flex-1 min-w-0 truncate', t.name || t.id));
    head.appendChild(el('span', 'text-[11px] px-2 py-0.5 rounded-full border border-border ' + (t.enabled ? 'text-state-success' : 'text-muted-foreground'), t.enabled ? '已启用' : '已停用'));
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.checked = !!t.enabled;
    sw.className = 'w-3.5 h-3.5 accent-[var(--hyacinth-primary)] shrink-0 cursor-pointer';
    sw.title = t.enabled ? '已启用（点击停用）' : '已停用（点击启用）';
    sw.onchange = () => {
      if (!connected) { sw.checked = !sw.checked; return; }
      sw.disabled = true;
      client.request('schedule.toggle', { id: t.id, enabled: sw.checked })
        .then(() => loadTasks())
        .catch((e) => { sw.checked = !sw.checked; sw.disabled = false; appendMsg('error', '切换失败: ' + (e && e.message || e)); });
    };
    head.appendChild(sw);
    const del = el('button', 'text-[11px] px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors shrink-0', '删除');
    del.style.color = 'var(--state-error)';
    let pendingDel = null;
    del.onclick = () => {
      if (!connected) return;
      if (pendingDel !== t.id) {
        pendingDel = t.id;
        del.textContent = '再点一次确认';
        setTimeout(() => { if (pendingDel === t.id) { pendingDel = null; del.textContent = '删除'; } }, 4000);
        return;
      }
      pendingDel = null;
      del.disabled = true;
      client.request('schedule.remove', { id: t.id })
        .then((res) => { appendMsg('system', (res && res.ok) ? '任务「' + (t.name || t.id) + '」已删除' : '删除未生效'); loadTasks(); })
        .catch((e) => { del.disabled = false; appendMsg('error', '删除失败: ' + (e && e.message || e)); });
    };
    head.appendChild(del);
    card.appendChild(head);
    const meta = el('div', 'flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground');
    meta.appendChild(el('span', '', '⏱ ' + (TASK_TYPE_LABEL[t.scheduleType] || t.scheduleType || '?')));
    if (t.nextRunAt) { try { meta.appendChild(el('span', '', '下次 ' + new Date(t.nextRunAt).toLocaleString())); } catch (e) { /* ignore */ } }
    if (typeof t.runCount === 'number') meta.appendChild(el('span', '', '已跑 ' + t.runCount + ' 次'));
    if (t.errorCount) meta.appendChild(el('span', 'text-state-error', '出错 ' + t.errorCount + ' 次'));
    card.appendChild(meta);
    return card;
  }
  async function loadTasks() {
    const listEl = $('#tasks-list');
    if (!listEl) return;
    bindTasksOnce();
    let data = null;
    try { data = await client.request('schedule.list'); } catch (e) { data = null; }
    if (!data) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'text-sm text-state-error', '取不到定时任务（后端可能未就绪）'));
      return;
    }
    const tasks = data.tasks || [];
    const statusEl = $('#tasks-status');
    if (statusEl) {
      const enabled = tasks.filter((t) => t.enabled).length;
      statusEl.textContent = 'add_task 建的调度任务，走 HeartbeatScheduler（cron / 持久化 / 补执行） · 已启用 ' + enabled + '/' + tasks.length;
    }
    listEl.innerHTML = '';
    if (!tasks.length) {
      listEl.appendChild(el('div', 'text-sm text-muted-foreground', '还没有定时任务。让 agent 用 add_task 建，或走 TUI /schedule。'));
      return;
    }
    tasks.forEach((t) => listEl.appendChild(taskRow(t)));
  }
  let tasksBound = false;
  function bindTasksOnce() {
    if (tasksBound) return;
    tasksBound = true;
    const refresh = $('#tasks-refresh-btn');
    if (refresh) refresh.onclick = () => { loadTasks(); };
  }

  // ── 插件视图（plugin 契约域：内核挂载 list + 目录插件管理面）────────
  // 目录插件可启停/重载（PluginManager 管理面经契约层暴露）；内核插件
  // （permission-chain/bypass/world-engine 等安全与能力基座）只读展示。

  const PLUGIN_STATUS_LABEL = {
    activated: '已启用',
    loaded: '已加载未启用',
    discovered: '已发现',
    deactivated: '已停用',
    error: '出错',
  };

  function pluginStatusBadge(st) {
    const cls = st === 'activated' ? 'is-ok'
      : st === 'error' ? 'is-error'
      : st === 'deactivated' || st === 'discovered' ? 'is-warn' : '';
    return el('span', 'plugin-badge ' + cls, PLUGIN_STATUS_LABEL[st] || st);
  }

  function pluginRow(p, actions) {
    const row = el('div', 'px-4 py-3 rounded-lg border border-border bg-card flex items-start justify-between gap-3');
    const left = el('div', 'min-w-0');
    const title = el('div', 'flex items-center gap-2 flex-wrap');
    title.appendChild(el('span', 'text-sm font-medium text-foreground', p.name || p.id));
    title.appendChild(el('span', 'text-xs text-muted-foreground font-mono', p.id));
    if (actions) title.appendChild(pluginStatusBadge(p.status));
    left.appendChild(title);
    if (p.description) left.appendChild(el('div', 'text-xs text-muted-foreground mt-1', p.description));
    if (p.error) left.appendChild(el('div', 'text-xs text-state-error mt-1 break-all', p.error));
    const meta = [];
    if (actions) {
      if (p.skillCount) meta.push('技能 ' + p.skillCount);
      if (p.mcpServerCount) meta.push('MCP ' + p.mcpServerCount);
    } else if (p.deps && p.deps.length) {
      meta.push('依赖 ' + p.deps.join(', '));
    }
    if (meta.length) left.appendChild(el('div', 'text-xs text-muted-foreground mt-1', meta.join(' · ')));
    row.appendChild(left);

    if (actions) {
      const btns = el('div', 'shrink-0 flex items-center gap-1.5');
      const mkBtn = (label, method, warn) => {
        const b = el('button', 'px-2.5 py-1 rounded-md border border-border text-xs font-medium transition-colors ' +
          (warn ? 'text-state-error hover:bg-state-error/10' : 'text-foreground hover:bg-muted-foreground/10'), label);
        b.type = 'button';
        b.onclick = async () => {
          b.disabled = true;
          try {
            await client.request(method, { id: p.id });
            await loadPlugins();
          } catch (err) {
            b.disabled = false;
            const hint = $('#plugins-status');
            if (hint) hint.textContent = (p.id + ' ' + label + '失败：' + (err && err.message || err));
          }
        };
        return b;
      };
      if (p.status === 'activated') btns.appendChild(mkBtn('停用', 'plugin.deactivate', true));
      else btns.appendChild(mkBtn('启用', 'plugin.activate'));
      btns.appendChild(mkBtn('重载', 'plugin.reload'));
      row.appendChild(btns);
    }
    return row;
  }

  async function loadPlugins() {
    const listEl = $('#plugins-list');
    if (!listEl) return;
    bindPluginsOnce();
    const statusEl = $('#plugins-status');
    let dir = null, kernel = null;
    try { dir = await client.request('plugin.listDirectory'); } catch (e) { dir = null; }
    try { kernel = await client.request('plugin.list'); } catch (e) { kernel = null; }

    if (statusEl) {
      const n = dir && dir.plugins ? dir.plugins.length : 0;
      const on = dir && dir.plugins ? dir.plugins.filter((p) => p.status === 'activated').length : 0;
      statusEl.textContent = dir
        ? ('目录插件 ' + on + '/' + n + ' 已启用 · 内核插件 ' + (kernel ? kernel.length : '?') + ' 个')
        : '目录插件管理不可用（后端未就绪）';
    }

    listEl.innerHTML = '';
    // 目录插件：可管理（启用/停用/重载）
    listEl.appendChild(el('div', 'text-xs font-semibold text-muted-foreground uppercase tracking-wide', '目录插件'));
    if (!dir) {
      listEl.appendChild(el('div', 'text-sm text-state-error', '取不到目录插件清单（后端可能未就绪）'));
    } else if (!dir.plugins.length) {
      listEl.appendChild(el('div', 'text-sm text-muted-foreground',
        '还没有目录插件。把带 plugin.json 的插件目录放进 ~/.agent/plugins/ 后点「刷新」。'));
    } else {
      const wrap = el('div', 'space-y-2');
      dir.plugins.forEach((p) => wrap.appendChild(pluginRow(p, true)));
      listEl.appendChild(wrap);
    }

    // 内核插件：只读（安全与能力基座）
    listEl.appendChild(el('div', 'text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-2', '内核插件'));
    if (!kernel || !kernel.length) {
      listEl.appendChild(el('div', 'text-sm text-muted-foreground', '取不到内核插件状态。'));
    } else {
      const wrap = el('div', 'space-y-2');
      kernel.forEach((p) => wrap.appendChild(pluginRow({
        id: p.id, name: p.id, description: '', status: p.state === 'error' ? 'error' : 'activated',
        error: p.error, deps: p.deps,
      }, false)));
      listEl.appendChild(wrap);
    }
  }

  // ── 技能视图（skill 契约域：列表 / 详情 / 启停）──────────────────
  // 技能是「按需激活的提示词包」：平时只进 Zone 2 索引，模型调用 Skill 工具
  // 才注入完整定义。因此管理界面的核心只有两件事：看清有什么、决定开不开。

  const SKILL_SOURCE_LABEL = {
    builtin: '内置',
    file: '文件',
    plugin: '插件',
    mcp: 'MCP',
    user: '用户',
  };

  function skillRow(s) {
    const row = el('div', 'skill-row');
    const head = el('div', 'skill-row-head');
    const info = el('div', 'skill-info');

    const title = el('div', 'skill-title');
    title.appendChild(el('span', 'skill-name', s.name));
    title.appendChild(el('span', 'skill-badge', SKILL_SOURCE_LABEL[s.source] || s.source));
    if (s.hasDir) title.appendChild(el('span', 'skill-badge', '目录式'));
    if (!s.enabled) title.appendChild(el('span', 'skill-badge', '已禁用'));
    info.appendChild(title);

    if (s.description) info.appendChild(el('div', 'skill-desc', s.description));
    if (s.relatedTools && s.relatedTools.length) {
      const tools = el('div', 'skill-tools');
      s.relatedTools.forEach((t) => tools.appendChild(el('span', 'skill-tool', t)));
      info.appendChild(tools);
    }

    const actions = el('div', 'skill-actions');
    const expand = el('button', 'skill-expand', '查看提示词');
    expand.type = 'button';
    const toggle = el('button', 'skill-toggle' + (s.enabled ? ' is-on' : ''));
    toggle.type = 'button';
    toggle.title = s.enabled ? '点击禁用' : '点击启用';
    toggle.setAttribute('aria-label', (s.enabled ? '禁用' : '启用') + ' ' + s.name);
    actions.appendChild(expand);
    actions.appendChild(toggle);

    head.appendChild(info);
    head.appendChild(actions);
    row.appendChild(head);

    const body = el('div', 'skill-body');
    row.appendChild(body);

    let loaded = false;
    expand.onclick = async () => {
      const open = row.classList.toggle('is-open');
      expand.textContent = open ? '收起' : '查看提示词';
      if (!open || loaded) return;
      expand.disabled = true;
      try {
        const res = await client.request('skill.get', { name: s.name });
        const detail = (res && res.skill) || {};
        const pre = el('pre', 'skill-prompt');
        pre.textContent = detail.promptTemplate || '（该技能没有提示词正文）';
        body.appendChild(pre);
        if (detail.dir) {
          const meta = el('div', 'skill-meta');
          meta.textContent = '技能目录：' + detail.dir;
          body.appendChild(meta);
        }
        loaded = true;
      } catch (e) {
        const meta = el('div', 'skill-meta');
        meta.textContent = '读取失败：' + (e && e.message || e);
        body.appendChild(meta);
      } finally {
        expand.disabled = false;
      }
    };

    toggle.onclick = async () => {
      const next = !toggle.classList.contains('is-on');
      toggle.disabled = true;
      try {
        await client.request('skill.toggle', { name: s.name, enabled: next });
        await loadSkills();
      } catch (e) {
        toggle.disabled = false;
        const statusEl = $('#skills-status');
        if (statusEl) statusEl.textContent = s.name + ' 切换失败：' + (e && e.message || e);
      }
    };

    return row;
  }

  async function loadSkills() {
    const listEl = $('#skills-list');
    if (!listEl) return;
    bindSkillsOnce();
    let data = null;
    try { data = await client.request('skill.list'); } catch (e) { data = null; }
    if (!data) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'skill-empty', '取不到技能列表（后端可能未就绪）'));
      return;
    }
    const skills = data.skills || [];
    const statusEl = $('#skills-status');
    if (statusEl) {
      const on = skills.filter((s) => s.enabled).length;
      statusEl.textContent = '共 ' + skills.length + ' 个技能 · 已启用 ' + on + ' 个' +
        (skills.length ? ' · 禁用后仅从上下文索引移除，随时可恢复' : '');
    }
    listEl.innerHTML = '';
    if (!skills.length) {
      listEl.appendChild(el('div', 'skill-empty',
        '还没有技能。把带 SKILL.md 的目录放进 ~/.agent/skills/ 后点「刷新」。'));
      return;
    }
    skills.forEach((s) => listEl.appendChild(skillRow(s)));
  }

  let skillsBound = false;
  function bindSkillsOnce() {
    if (skillsBound) return;
    skillsBound = true;
    const refresh = $('#skills-refresh-btn');
    if (refresh) refresh.onclick = () => { loadSkills(); };
  }

  /** 绑定插件工具条（只绑一次；由 loadPlugins 触发 ⇒ 视图 markup 必已在） */
  let pluginsBound = false;
  function bindPluginsOnce() {
    if (pluginsBound) return;
    pluginsBound = true;
    const refresh = $('#plugins-refresh-btn');
    if (refresh) refresh.onclick = () => { loadPlugins(); };
  }

  /** 绑定工具条（只绑一次 ✓；由 loadSchedule 触发 ⇒ 视图 markup 必已在 ✓） */
  function bindScheduleOnce() {
    if (scheduleBound) return;
    const addBtn = $('#automation-add-btn');
    if (!addBtn) return;
    scheduleBound = true;
    const refresh = $('#automation-refresh-btn');
    if (refresh) refresh.onclick = () => { loadSchedule(); };

    // 子标签切换：自动化规则 / 定时任务（定时任务=自动化的一种形式，同页呈现）
    const tabRules = $('#auto-tab-rules');
    const tabTasks = $('#auto-tab-tasks');
    const rulesView = $('#auto-rules-view');
    const tasksView = $('#auto-tasks-view');
    const activeTabCls = ['bg-background', 'text-foreground', 'border', 'border-b-0', 'border-border'];
    const inactiveTabCls = ['text-muted-foreground'];
    const switchAutoTab = (which) => {
      const isTasks = which === 'tasks';
      if (rulesView) rulesView.hidden = isTasks;
      if (tasksView) tasksView.hidden = !isTasks;
      for (const b of [tabRules, tabTasks]) {
        if (!b) continue;
        const active = (b === tabTasks) === isTasks;
        activeTabCls.forEach((c) => b.classList.toggle(c, active));
        inactiveTabCls.forEach((c) => b.classList.toggle(c, !active));
      }
      if (isTasks) loadTasks();
    };
    if (tabRules) tabRules.onclick = () => switchAutoTab('rules');
    if (tabTasks) tabTasks.onclick = () => switchAutoTab('tasks');

    const hint = (msg, ok) => {
      const h = $('#automation-hint');
      if (!h) return;
      h.textContent = msg || '';
      h.style.color = ok ? 'var(--state-success)' : 'var(--state-error)';
    };

    // ── 触发类型切换（probe / time / event）──
    const tt = $('#automation-trigger-type');
    const whenProbe = $('#automation-when-probe');
    const whenTime = $('#automation-when-time');
    const whenEvent = $('#automation-when-event');
    const applyTrigger = () => {
      const v = tt ? tt.value : 'probe';
      if (whenProbe) whenProbe.hidden = v !== 'probe';
      if (whenTime) whenTime.hidden = v !== 'time';
      if (whenEvent) whenEvent.hidden = v !== 'event';
    };
    if (tt) { tt.addEventListener('change', applyTrigger); applyTrigger(); }

    // ── probe kind 切换 → 结构化字段（替代手写 JSON spec）──
    const pk = $('#automation-probe-kind');
    const pf = $('#automation-probe-fields');
    const mkInput = (id, ph, flex) => {
      const i = document.createElement('input');
      i.type = (id === 'pf-port' || id === 'pf-expectStatus') ? 'number' : 'text';
      i.id = id;
      i.placeholder = ph;
      i.className = 'h-8 px-2 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground ' + (flex ? 'flex-1 min-w-[180px]' : 'w-[130px]');
      return i;
    };
    const mkSelect = (id, opts) => {
      const s = document.createElement('select');
      s.id = id;
      s.className = 'h-8 px-2 rounded-md bg-background border border-border text-sm text-foreground';
      for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); }
      return s;
    };
    const renderProbeFields = () => {
      if (!pf || !pk) return;
      pf.innerHTML = '';
      const kind = pk.value;
      if (kind === 'process') {
        pf.appendChild(mkInput('pf-name', '进程名 例 steam', true));
        pf.appendChild(mkSelect('pf-expect', ['running', 'exit']));
      } else if (kind === 'file') {
        pf.appendChild(mkInput('pf-path', '文件路径', true));
        pf.appendChild(mkSelect('pf-watch', ['content', 'mtime']));
      } else if (kind === 'http') {
        pf.appendChild(mkInput('pf-url', 'URL', true));
        pf.appendChild(mkSelect('pf-method', ['GET', 'HEAD', 'POST']));
        pf.appendChild(mkInput('pf-expectStatus', '期望状态码 例 200'));
      } else if (kind === 'port') {
        pf.appendChild(mkInput('pf-port', '端口', false));
        pf.appendChild(mkSelect('pf-expect', ['open', 'closed']));
      } else if (kind === 'ui_region') {
        pf.appendChild(mkInput('pf-region', '区域 left,top,right,bottom（空=全屏）', true));
      }
    };
    if (pk) { pk.addEventListener('change', renderProbeFields); renderProbeFields(); }

    // ── 动作链：多动作，可增删 ──
    const actionsEl = $('#automation-actions');
    const addActionRow = () => {
      if (!actionsEl) return;
      const row = document.createElement('div');
      row.className = 'flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 automation-action-row';

      const sinkSel = document.createElement('select');
      sinkSel.className = 'automation-act-sink h-8 px-2 rounded-md bg-card border border-border text-sm text-foreground shrink-0';
      [['invoke', '⚙ 跑工具'], ['wake', '💬 唤醒会话']].forEach((o) => {
        const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sinkSel.appendChild(op);
      });

      const invWrap = document.createElement('div');
      invWrap.className = 'automation-act-invoke flex flex-wrap items-center gap-2 flex-1';
      const toolI = document.createElement('input');
      toolI.className = 'automation-act-tool h-8 px-2 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground w-[150px]';
      toolI.placeholder = '工具名 例 bash/say/write';
      const argsI = document.createElement('input');
      argsI.className = 'automation-act-args h-8 px-2 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground flex-1 min-w-[180px]';
      argsI.placeholder = '参数 JSON 例 {"command":"..."} / {"content":"..."}';
      invWrap.appendChild(toolI); invWrap.appendChild(argsI);

      const wakeWrap = document.createElement('div');
      wakeWrap.className = 'automation-act-wake flex flex-wrap items-center gap-2 flex-1';
      wakeWrap.hidden = true;
      const polSel = document.createElement('select');
      polSel.className = 'automation-act-policy h-8 px-2 rounded-md bg-card border border-border text-sm text-foreground';
      [['reuse', '复用会话(带历史)'], ['new', '新临时会话(干净)']].forEach((o) => {
        const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; polSel.appendChild(op);
      });
      const sessI = document.createElement('input');
      sessI.className = 'automation-act-session h-8 px-2 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground w-[160px]';
      sessI.placeholder = '目标会话id(可空=当前)';
      const promptI = document.createElement('input');
      promptI.className = 'automation-act-prompt h-8 px-2 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground flex-1 min-w-[160px]';
      promptI.placeholder = '给模型的话 例 微信关了，提醒我一下';
      wakeWrap.appendChild(polSel); wakeWrap.appendChild(sessI); wakeWrap.appendChild(promptI);

      const del = document.createElement('button');
      del.className = 'text-[11px] px-2 py-1 rounded-md border border-border bg-card text-foreground hover:bg-muted shrink-0';
      del.textContent = '×';
      del.style.color = 'var(--state-error)';
      del.onclick = () => { row.remove(); };

      sinkSel.onchange = () => {
        const isInvoke = sinkSel.value === 'invoke';
        invWrap.hidden = !isInvoke;
        wakeWrap.hidden = isInvoke;
      };

      row.appendChild(sinkSel);
      row.appendChild(invWrap);
      row.appendChild(wakeWrap);
      row.appendChild(del);
      actionsEl.appendChild(row);
    };
    const addActionBtn = $('#automation-add-action');
    if (addActionBtn) addActionBtn.onclick = addActionRow;
    addActionRow();

    // ── 完整 JSON 模式切换 ──
    const jsonToggle = $('#automation-json-toggle');
    const jsonArea = $('#automation-json');
    if (jsonToggle && jsonArea) jsonToggle.onclick = () => { jsonArea.hidden = !jsonArea.hidden; };

    // ── 收集 probe spec（结构化 → spec 对象）──
    const collectSpec = (kind) => {
      const val = (id) => { const e = $('#' + id); return e ? String(e.value || '').trim() : ''; };
      if (kind === 'process') { const s = {}; if (val('pf-name')) s.name = val('pf-name'); s.expect = val('pf-expect') || 'exit'; return s; }
      if (kind === 'file') { const s = {}; if (val('pf-path')) s.path = val('pf-path'); if (val('pf-watch')) s.watch = val('pf-watch'); return s; }
      if (kind === 'http') { const s = {}; if (val('pf-url')) s.url = val('pf-url'); if (val('pf-method')) s.method = val('pf-method'); if (val('pf-expectStatus')) s.expectStatus = Number(val('pf-expectStatus')); return s; }
      if (kind === 'port') { const s = {}; if (val('pf-port')) s.port = Number(val('pf-port')); s.expect = val('pf-expect') || 'open'; return s; }
      if (kind === 'ui_region') { const s = {}; if (val('pf-region')) s.region = val('pf-region').split(',').map((x) => Number(x.trim())); return s; }
      return {};
    };

    // ── 收集动作链 ──
    const collectActions = () => {
      const rows = actionsEl ? Array.from(actionsEl.querySelectorAll('.automation-action-row')) : [];
      const out = [];
      for (const row of rows) {
        const sink = (row.querySelector('.automation-act-sink') || {}).value || 'invoke';
        if (sink === 'invoke') {
          const tool = ((row.querySelector('.automation-act-tool') || {}).value || '').trim();
          const argsRaw = ((row.querySelector('.automation-act-args') || {}).value || '').trim();
          if (!tool) throw new Error('有个动作没填工具名');
          let args = {};
          if (argsRaw) { try { args = JSON.parse(argsRaw); } catch { throw new Error('动作参数必须是合法 JSON：' + argsRaw); } }
          out.push({ sink: 'invoke', tool, args });
        } else {
          const policy = ((row.querySelector('.automation-act-policy') || {}).value || 'reuse');
          const sess = ((row.querySelector('.automation-act-session') || {}).value || '').trim();
          const prompt = ((row.querySelector('.automation-act-prompt') || {}).value || '').trim();
          const where = { policy };
          if (sess) where.target = { sessionId: sess };
          const act = { sink: 'wake', where };
          if (prompt) act.prompt = prompt;
          out.push(act);
        }
      }
      return out;
    };

    addBtn.onclick = () => {
      if (!connected) { hint('尚未连接后端'); return; }
      const name = (($('#automation-name') || {}).value || '').trim();
      const enable = !!($('#automation-enable') || {}).checked;
      if (!name) { hint('请先填规则名称'); return; }

      let rule;
      if (jsonArea && !jsonArea.hidden && (jsonArea.value || '').trim()) {
        // 完整 JSON 模式：直接用它（覆盖表单）
        try { rule = JSON.parse(jsonArea.value); }
        catch (e) { hint('完整 JSON 不合法：' + e.message); return; }
        if (!rule.id) rule.id = 'ui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (rule.name === undefined) rule.name = name;
        if (rule.enabled === undefined) rule.enabled = false;
      } else {
        const triggerType = ($('#automation-trigger-type') || {}).value || 'probe';
        let when;
        try {
          if (triggerType === 'time') {
            const st = ($('#automation-schedule-type') || {}).value || 'interval';
            const sv = (($('#automation-schedule-value') || {}).value || '').trim();
            if (!sv) throw new Error('请填时间参数（间隔分钟 / HH:mm / cron / ISO）');
            if (st === 'interval') { const mins = Number(sv); if (!Number.isFinite(mins) || mins <= 0) throw new Error('间隔请填分钟数，例 30'); when = { kind: 'time', schedule: { intervalMs: Math.round(mins * 60000) } }; }
            else if (st === 'daily') { if (!/^\d{1,2}:\d{2}$/.test(sv)) throw new Error('每天定点格式 HH:mm，例 09:30'); when = { kind: 'time', schedule: { time: sv } }; }
            else if (st === 'cron') { if (sv.split(/\s+/).filter(Boolean).length !== 5) throw new Error('cron 需 5 字段，例 0 9 * * *'); when = { kind: 'time', schedule: { expression: sv } }; }
            else { when = { kind: 'time', schedule: { runAt: sv } }; }
          } else if (triggerType === 'event') {
            const ev = (($('#automation-event') || {}).value || '').trim();
            if (!ev) throw new Error('请填事件名');
            when = { kind: 'event', event: ev };
          } else {
            const pkVal = ($('#automation-probe-kind') || {}).value || 'process';
            const spec = collectSpec(pkVal);
            when = { kind: 'probe', probe: { kind: pkVal, spec } };
            const ivRaw = (($('#automation-probe-interval') || {}).value || '').trim();
            if (ivRaw) { const iv = Number(ivRaw); if (Number.isFinite(iv) && iv > 0) when.probe.intervalMs = iv; }
          }
        } catch (e) { hint(e.message); return; }
        let actions;
        try { actions = collectActions(); } catch (e) { hint(e.message); return; }
        if (!actions.length) { hint('至少加一个动作'); return; }
        const id = 'ui-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        rule = { id, name, enabled: false, when, do: actions };
        const mrRaw = (($('#automation-maxruns') || {}).value || '').trim();
        if (mrRaw) { const mr = Number(mrRaw); if (Number.isFinite(mr) && mr >= 1) rule.maxRuns = Math.floor(mr); }
      }

      addBtn.disabled = true;
      client.request('automation.create', { rule, enable })
        .then((res) => {
          if (res && res.ok === false) { hint('添加失败：' + (res.errors || []).join('；')); return; }
          hint('已添加规则：' + name, true);
          const nEl = $('#automation-name'); if (nEl) nEl.value = '';
          if (jsonArea) jsonArea.value = '';
          loadSchedule();
        })
        .catch((e) => hint('添加失败: ' + (e && e.message)))
        .finally(() => { addBtn.disabled = false; });
    };
  }

  // ════════════════════════════════════════════════════════════
  // 图片附件（粘贴 / 拖入 / 点选）
  // 后端早就有完整通路：message.chat 的 images → loop.channelImages
  //   → context 阶段按 inputTypes 门控注入（见 loop.ts:1614）。
  // 此前前端只有一句「后续版本支持」的占位，能力其实是通的 ✓
  // ════════════════════════════════════════════════════════════
  /** 待发送图片：{ data (base64 无前缀), media_type, name } */
  let pendingImages = [];
  /** 单条消息的图片上限：超过这个量，请求体和前端渲染都会明显变慢 */
  const MAX_PENDING_IMAGES = 4;
  /** 单张上限 8MB（base64 后约 10.7MB；再大 base64 传输会卡 UI） */
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  function renderAttachments() {
    const box = $('#composer-attachments');
    const hint = $('#composer-attach-hint');
    if (!box) return;
    box.innerHTML = '';
    if (!pendingImages.length) {
      box.hidden = true;
      if (hint) hint.classList.add('hidden');
      return;
    }
    box.hidden = false;
    if (hint) hint.classList.remove('hidden');
    pendingImages.forEach((img, idx) => {
      const cell = el('div', 'composer-attachment');
      const im = document.createElement('img');
      im.src = `data:${img.media_type};base64,${img.data}`;
      im.alt = img.name || '待发送图片';
      cell.appendChild(im);
      const del = el('button', 'composer-attachment-x', '×');
      del.type = 'button';
      del.setAttribute('aria-label', '移除图片');
      del.onclick = () => { pendingImages.splice(idx, 1); renderAttachments(); };
      cell.appendChild(del);
      box.appendChild(cell);
    });
  }

  /** 读文件 → base64（去掉 dataURL 前缀，协议只收裸 base64） */
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || '')) { resolve(null); return; }
      if (file.size > MAX_IMAGE_BYTES) {
        reject(new Error(`${file.name || '图片'} 超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`));
        return;
      }
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('读取图片失败'));
      fr.onload = () => {
        const s = String(fr.result || '');
        const comma = s.indexOf(',');
        if (comma < 0) { reject(new Error('图片编码失败')); return; }
        resolve({
          data: s.slice(comma + 1),
          media_type: file.type || 'image/png',
          name: file.name || '',
        });
      };
      fr.readAsDataURL(file);
    });
  }

  async function addImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type || ''));
    if (!files.length) return;
    const room = MAX_PENDING_IMAGES - pendingImages.length;
    if (room <= 0) {
      appendMsg('system', `最多 ${MAX_PENDING_IMAGES} 张图片`);
      return;
    }
    for (const f of files.slice(0, room)) {
      try {
        const img = await readImageFile(f);
        if (img) pendingImages.push(img);
      } catch (e) {
        appendMsg('error', (e && e.message) || '图片读取失败');
      }
    }
    if (files.length > room) appendMsg('system', `只保留前 ${MAX_PENDING_IMAGES} 张图片`);
    renderAttachments();
  }

  /**
   * 全局交互：快捷键 + 回到底部。
   * 单独一个函数而不是塞进 bindUI —— bindUI 已经有 200 行，再加会让"哪里绑了什么"更难查。
   */
  function bindGlobalInteractions() {
    // Ctrl/⌘+K：聚焦会话搜索（最常见的"我要找上次那个会话"）
    // Esc：先清搜索，再关抽屉；两层都空才让浏览器处理
    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const box = $('#sidebar-recent');
        if (box && box.hidden) setNavDrawer(true);   // 抽屉里也能搜
        const s = $('#session-search');
        if (s) { s.focus(); s.select(); }
        return;
      }
      // Ctrl/⌘+Alt+P：开合右侧文件预览栏（P = Preview）
      if (meta && e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        pvSetOpen(!pv.open);
        return;
      }
      if (e.key === 'Escape') {
        const s = $('#session-search');
        if (s && document.activeElement === s) {
          s.value = '';
          renderSidebarRecent();
          s.blur();
          e.preventDefault();
          return;
        }
        if ($('#app-shell').classList.contains('nav-open')) { setNavDrawer(false); e.preventDefault(); }
      }
    });

    // 回到底部：长对话滚上去后浮出，点一下回到底
    const fab = $('#scroll-fab');
    const ml = $('#message-list');
    if (fab && ml) {
      const syncFab = () => {
        const gap = ml.scrollHeight - ml.scrollTop - ml.clientHeight;
        fab.hidden = gap < 160;
      };
      ml.addEventListener('scroll', syncFab, { passive: true });
      // 新消息追加时也要重算（否则"正在底部收到新消息"时按钮不出现）
      new MutationObserver(syncFab).observe(ml, { childList: true });
      fab.addEventListener('click', () => {
        ml.scrollTo({ top: ml.scrollHeight, behavior: 'smooth' });
        fab.hidden = true;
      });
      syncFab();
    }
  }

  // ════════════════════════════════════════════════════════════
  // 预览栏：工作区文件查看器（只读）
  // ════════════════════════════════════════════════════════════
  // 数据面走 UI 契约层（preview.* 域，src/ui-protocol/domains/preview.ts）。
  // 越界、符号链接、绝对路径都在服务端 fail-closed，这里**不重复做安全判断**
  // —— 前端校验只是装饰，绕过它只需一行调用。这里只负责展示和交互。
  const PV_KEY = 'hyacinth.preview';
  /** 行号渲染上限：几万行的日志/产物会把 DOM 撑爆，只渲染前 N 行并提示 */
  const PV_MAX_LINES = 5000;

  const pv = {
    open: false,        // 是否展开
    max: false,         // 是否放大铺满正文区（见 pvSetMax）
    full: false,        // 是否全屏阅读：铺满整个窗口 + 隐藏目录（见 pvSetFull）
    width: 380,         // 栏宽 px
    treeH: 46,          // 竖排时：文件树占整栏高度的百分比
    treeW: 300,         // 放大态（横排）时：右侧目录列的宽度 px
    rootName: '',       // 当前根目录名（后端给；可切换）
    rootAbs: '',        // 当前根绝对路径（剥工具参数里的前缀用）
    rootDefault: '',    // 启动时的工作区（"回到工作区"的目标）
    isCustomRoot: false,// 是否已经换过根
    cwd: '.',           // 当前树的根目录（相对路径）
    showAll: false,     // 是否显示 node_modules 等依赖目录
    expanded: new Set(),// 已展开的目录
    children: new Map(),// path -> entries[]（目录内容缓存）
    inflight: new Set(),// 正在请求的目录
    current: null,      // 当前预览的文件元信息
    htmlSource: false,  // HTML 预览：false=渲染（iframe）/ true=源码；跨文件保留用户的偏好
    pendingPath: '',    // ?preview=<path> 待到位的文件
  };

  function pvClamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // ── 数据面：全部走 UI 契约层（preview.* RPC）──────────────────
  // 此前这里是一组直连 HTTP 的 fetch（/api/fs/list|read|meta|browse|root），
  // 与聊天等能力形成两套通道；现在统一收进契约层 —— 服务端 preview 域做
  // 同一套 fail-closed 校验，前端不再硬编码任何后端 HTTP 路径。
  // 仅原始字节（<img>/<iframe> 加载）仍是 HTTP：浏览器那几处无法设置请求头，
  // 地址由服务端签发（preview.read 的 url 字段 / preview.rawUrl，?token= 已嵌入）。

  /**
   * bindPreviewDock 在 IIFE 顶层早于 client 创建执行（初始化拉 meta），
   * 预览栏的启动期 RPC 统一排队到 WS onOpen 之后；其余调用都由用户交互
   * 触发，天然晚于就绪。
   */
  let pvResolveReady;
  const pvReady = new Promise((res) => { pvResolveReady = res; });

  /** 契约层 RPC（reject 的是 {code,message}，与旧 fetch 错误一样取 .message） */
  function pvRpc(method, params) {
    return client.request('preview.' + method, params || {});
  }

  function pvSave() {
    try {
      localStorage.setItem(PV_KEY, JSON.stringify({
        open: pv.open, max: pv.max, full: pv.full, width: pv.width,
        treeH: pv.treeH, treeW: pv.treeW,
      }));
    } catch (e) { /* 隐私模式 / 配额满：布局不持久化也能用，不影响功能 */ }
  }

  function pvLoadPrefs() {
    try {
      const s = JSON.parse(localStorage.getItem(PV_KEY) || 'null');
      if (s) {
        if (typeof s.width === 'number') pv.width = pvClamp(s.width, 280, 760);
        if (typeof s.treeH === 'number') pv.treeH = pvClamp(s.treeH, 15, 85);
        if (typeof s.treeW === 'number') pv.treeW = pvClamp(s.treeW, 200, 560);
        if (typeof s.open === 'boolean') pv.open = s.open;
        // 放大态也持久化：它和"关掉预览"不同，用户是主动选择用整屏读文件的，
        // 下次打开接着用才符合预期（关栏时 pvSetOpen 会把它清掉）。
        if (s.max === true) pv.max = true;
        // 全屏态只在"上次也是放大态"时才恢复：full 隐含 max，单独记一个 true 而
        // max 为 false 的话状态就不自洽了（pvApplyMode 会把它抹平）。
        if (s.full === true && pv.max) pv.full = true;
      }
    } catch (e) { /* 坏数据：用默认值 */ }
    // ?preview=1 直接展开预览栏；?preview=<相对路径> 额外定位到那个文件。
    // 除了方便生成"指向某个文件"的链接，也让无头截图能拍到展开后的样子
    // （浏览器 profile 是干净的，localStorage 为空，否则永远拍不到这一栏）。
    const flag = new URLSearchParams(location.search).get('preview');
    if (flag === '1' || flag === 'open' || flag === 'true') {
      pv.open = true;
    } else if (flag) {
      pv.open = true;
      pv.pendingPath = flag;
    }
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
    return (n / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
  }

  function pvIcon(name, cls) {
    const i = document.createElement('i');
    i.setAttribute('data-lucide', name);
    if (cls) i.className = cls;
    return i;
  }

  /** 文件图标（按扩展名粗分，够用即可；不必引入完整图标映射） */
  function pvIconFor(name, isDir, ext) {
    if (isDir) return 'folder';
    const e = (ext || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'].includes(e)) return 'image';
    if (e === '.pdf') return 'file-text';
    if (['.md', '.markdown'].includes(e)) return 'book-open';
    if (['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.cs', '.sh'].includes(e)) return 'file-code';
    if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(e)) return 'package';
    return 'file';
  }

  function pvNote(text, isError) {
    const n = el('div', 'pv-tree-note' + (isError ? ' is-error' : ''), text);
    $('#pv-tree').appendChild(n);
  }

  // ── 文件树 ────────────────────────────────────────────────────

  async function pvLoadDir(dirPath, force) {
    if (pv.inflight.has(dirPath)) return;
    if (!force && pv.children.has(dirPath)) return;
    pv.inflight.add(dirPath);
    try {
      const data = await pvRpc('list', { path: dirPath, all: pv.showAll });
      pv.children.set(dirPath, data.entries || []);
      pvRenderTree();
      if (data.truncated) pvNote('这个目录条目过多，只显示了前一部分');
    } catch (err) {
      pv.children.set(dirPath, []);
      pvRenderTree();
      pvNote('读取失败：' + (err.message || String(err)), true);
    } finally {
      pv.inflight.delete(dirPath);
    }
  }

  /**
   * 渲染整棵树：扁平列表 + 缩进，而不是嵌套 <ul>。
   * 理由：嵌套结构在"展开/收起"时要逐层维护 DOM，扁平列表只需重画一次，
   * 缩进是纯样式（padding-left），滚动位置也更好保持。
   */
  function pvRenderTree() {
    const tree = $('#pv-tree');
    if (!tree) return;
    tree.textContent = '';

    const walk = (dirPath, depth) => {
      const entries = pv.children.get(dirPath);
      if (!entries) return;
      for (const e of entries) {
        tree.appendChild(pvRow(e, depth));
        if (e.type === 'dir' && pv.expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(pv.cwd, 0);

    if (!tree.children.length) {
      pvNote(pv.children.has(pv.cwd) ? '这个目录是空的' : '正在读取…');
    }
    // 依赖目录默认隐藏：给一次"显示"的入口，而不是让它凭空消失
    if (!pv.showAll) {
      const hint = el('button', 'pv-tree-note is-action', '已隐藏 node_modules 等依赖目录 · 显示');
      hint.type = 'button';
      hint.onclick = () => {
        pv.showAll = true;
        pv.children.clear();          // 缓存里的条目是按旧口径取的，必须重取
        pvLoadDir(pv.cwd, true);
      };
      tree.appendChild(hint);
    }
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  function pvRow(entry, depth) {
    const isDir = entry.type === 'dir';
    // is-open 挂在行上而不是只挂箭头：lucide 替换 <i>→<svg> 时不保证保留 class，
    // 挂在父元素上则"箭头转 90°"这条样式始终成立。
    const isOpen = isDir && pv.expanded.has(entry.path);
    const row = el('div', 'pv-item'
      + (isDir ? ' is-dir' : '')
      + (isOpen ? ' is-open' : '')
      + (pv.current && pv.current.path === entry.path ? ' is-active' : ''));
    row.style.paddingLeft = (8 + depth * 13) + 'px';
    row.setAttribute('role', 'treeitem');
    row.tabIndex = 0;

    const caret = pvIcon('chevron-right', 'pv-caret');
    if (!isDir) caret.classList.add('is-leaf');
    row.appendChild(caret);

    row.appendChild(pvIcon(pvIconFor(entry.name, isDir, extOf(entry.name)), 'pv-file-icon'));
    row.appendChild(el('span', 'pv-name', entry.name));
    if (!isDir) row.appendChild(el('span', 'pv-size', fmtSize(entry.size)));

    row.onclick = () => pvActivate(entry);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pvActivate(entry); }
      else if (e.key === 'ArrowRight' && isDir && !pv.expanded.has(entry.path)) { e.preventDefault(); pvActivate(entry); }
      else if (e.key === 'ArrowLeft' && isDir && pv.expanded.has(entry.path)) { e.preventDefault(); pvActivate(entry); }
    };

    // ── 拖到输入框 = 插入该文件的绝对路径 ──────────────────────
    // 只给文件加（目录拖进去得到的是一串路径，agent 反而要去列目录；
    // 而且目录行本身是"点开/收起"，draggable 会让轻微拖动吞掉点击）。
    if (!isDir) {
      row.draggable = true;
      row.classList.add('is-draggable');
      row.addEventListener('dragstart', (e) => {
        const abs = pvAbsPath(entry.path);
        // 自定义类型是给 composer 认的"这是本应用的文件"；
        // text/plain 让用户能拖到浏览器地址栏/编辑器里当普通路径用
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-hyacinth-path', entry.path);
        e.dataTransfer.setData('text/plain', abs);
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    }
    return row;
  }

  /**
   * 工作区相对路径 → 绝对路径。
   * Windows 下用反斜杠（与服务端返回的 rootAbs 保持同一种写法），其余用正斜杠。
   */
  function pvAbsPath(rel) {
    const root = String(pv.rootAbs || '').replace(/[\\/]+$/, '');
    if (!root) return rel;                       // 拿不到 root（meta 未就绪）：退回相对路径
    const sep = root.includes('\\') ? '\\' : '/';
    return root + sep + String(rel).split('/').join(sep);
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i) : '';
  }

  async function pvActivate(entry) {
    if (entry.type === 'dir') {
      if (pv.expanded.has(entry.path)) {
        pv.expanded.delete(entry.path);
        pvRenderTree();
      } else {
        pv.expanded.add(entry.path);
        pvRenderTree();
        await pvLoadDir(entry.path);
      }
      return;
    }
    pv.current = { path: entry.path, name: entry.name };
    pvRenderTree();
    await pvOpenFile(entry.path);
  }

  /** 面包屑：既是"我在哪"，也是逐级返回的入口 */
  function pvRenderCrumbs() {
    const box = $('#pv-crumbs');
    if (!box) return;
    box.textContent = '';
    const parts = pv.cwd === '.' ? [] : pv.cwd.split('/').filter(Boolean);
    const add = (label, target, isCurrent) => {
      if (box.children.length) box.appendChild(el('span', 'pv-crumb-sep', '/'));
      const b = el('button', 'pv-crumb' + (isCurrent ? ' is-current' : ''), label);
      b.type = 'button';
      if (!isCurrent) {
        b.onclick = async () => {
          pv.cwd = target;
          pv.expanded.add(target);
          pvRenderCrumbs();
          pvRenderTree();
          await pvLoadDir(target);
        };
      }
      box.appendChild(b);
    };
    add(pv.rootName || '工作区', '.', parts.length === 0);
    let acc = '';
    parts.forEach((p, i) => {
      acc = acc ? acc + '/' + p : p;
      add(p, acc, i === parts.length - 1);
    });
  }

  // ── 内容区 ────────────────────────────────────────────────────

  async function pvOpenFile(path) {
    const content = $('#pv-content');
    const meta = $('#pv-meta');
    const empty = $('#pv-empty');
    if (!content) return;
    content.textContent = '';
    content.hidden = false;
    meta.hidden = false;
    empty.hidden = true;
    content.appendChild(el('div', 'pv-tree-note', '读取中…'));

    try {
      const data = await pvRpc('read', { path });
      pv.current = data;
      pvRenderMeta(data);
      content.textContent = '';
      if (data.kind === 'markdown') pvRenderMarkdown(content, data);
      else if (data.kind === 'docx') pvRenderDocx(content, data);
      else if (data.kind === 'image') pvRenderImage(content, data);
      else if (data.kind === 'pdf') pvRenderPdf(content, data);
      else if (data.kind === 'html') pvRenderHtml(content, data);
      else if (data.binary) pvRenderBinary(content, data);
      else pvRenderText(content, data);
      pvRenderTree();
    } catch (err) {
      content.textContent = '';
      const box = el('div', 'pv-binary', '读取失败：' + (err.message || String(err)));
      content.appendChild(box);
    }
  }

  function pvRenderMeta(d) {
    const meta = $('#pv-meta');
    if (!meta) return;
    meta.textContent = '';
    meta.appendChild(el('span', 'pv-meta-name', d.name));
    if (d.lang) meta.appendChild(el('span', 'pv-badge', d.lang));
    meta.appendChild(el('span', 'pv-badge', fmtSize(d.size)));
    if (d.truncated) {
      meta.appendChild(el('span', 'pv-badge is-warn', '已截断'));
    }
    // HTML：渲染 / 源码 切换。放在 meta 行最右，不占正文空间
    if (d.kind === 'html') {
      const btn = el('button', 'pv-src-toggle', pv.htmlSource ? '预览' : '源码');
      btn.type = 'button';
      btn.title = pv.htmlSource ? '用浏览器渲染这个页面' : '查看 HTML 源码';
      btn.onclick = () => pvToggleHtmlSource();
      meta.appendChild(btn);
    }
  }

  function pvRenderMarkdown(box, d) {
    // ⚠️ 必须**先 appendChild 再渲染**：renderRichInto 里给公式排队时要求
    //    node.isConnected，脱链的节点会被判成"已切换会话"而永远不补公式。
    const div = el('div', 'pv-md msg-rich');
    box.appendChild(div);
    // markdown.js 的输出是可信 HTML（它自己做转义），与聊天正文同一条渲染路径；
    // 高亮与公式加载也一并在这里处理（预览栏的 .md 同样要能看公式）
    renderRichInto(div, d.content);
    if (d.truncated) pvTruncNote(box, d);
  }

  /**
   * docx 语义预览：服务端 mammoth 转好的 HTML（已消毒）直接 innerHTML。
   * ⚠️ 不能走 renderRichInto —— markdown.js 会先 escapeHtml 再拼，mammoth 的
   * HTML 会被整体转义成源码。消毒责任在服务端（sanitizeDocxHtml：mammoth
   * 白名单重建 + script/事件属性/危险协议剥离）。
   */
  function pvRenderDocx(box, d) {
    const div = el('div', 'pv-md msg-rich');
    box.appendChild(div);
    div.innerHTML = d.content;
    if (d.truncated) pvTruncNote(box, d);
  }

  function pvRenderImage(box, d) {
    const wrap = el('div', 'pv-image-wrap');
    const img = document.createElement('img');
    // url 由契约层签发（preview.read 结果自带，?token= 服务端已嵌入）
    img.src = d.url;
    img.alt = d.name;
    img.onload = () => { img.title = d.name; };
    img.onerror = () => {
      wrap.textContent = '';
      wrap.appendChild(el('div', 'pv-binary', '图片加载失败（可能已损坏，或格式不受支持）'));
    };
    wrap.appendChild(img);
    box.appendChild(wrap);
  }

  function pvRenderPdf(box, d) {
    const f = document.createElement('iframe');
    f.className = 'pv-pdf';
    f.src = d.url;
    f.title = d.name;
    box.appendChild(f);
  }

  /**
   * HTML 预览：默认用 iframe 渲染真实页面，meta 行可切回源码。
   *
   * ⚠️ sandbox **刻意不给 allow-same-origin**：给了的话，本地页面里的脚本就能
   * 直接 fetch `/api/fs/read?path=…` 读工作区任意文件（同源带 cookie/token）。
   * 现在脚本照常运行（allow-scripts），但 origin 是 opaque，拿不到本应用的 API。
   * 代价：依赖 localStorage / 同源 iframe 通信的页面会报错 —— 对"看一眼长什么样"够用。
   */
  function pvRenderHtml(box, d) {
    if (pv.htmlSource) {
      pvRenderText(box, d);
      return;
    }
    const f = document.createElement('iframe');
    f.className = 'pv-html-frame';
    f.src = d.url;
    f.title = d.name;
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    f.setAttribute('referrerpolicy', 'no-referrer');
    box.appendChild(f);
  }

  /** 渲染 / 源码 之间切换（只对 HTML 生效） */
  function pvToggleHtmlSource() {
    const d = pv.current;
    if (!d || d.kind !== 'html') return;
    pv.htmlSource = !pv.htmlSource;
    const content = $('#pv-content');
    if (!content) return;
    content.textContent = '';
    if (pv.htmlSource) pvRenderText(content, d);
    else pvRenderHtml(content, d);
    pvRenderMeta(d);
    content.scrollTop = 0;
  }

  function pvRenderBinary(box, d) {
    const wrap = el('div', 'pv-binary');
    wrap.appendChild(el('div', '', '这是二进制文件，预览栏不下发原始内容。'));
    wrap.appendChild(el('div', '', fmtSize(d.size) + ' · ' + (d.ext || '未知类型')));
    const a = el('a', 'pv-open-link', '在新标签页打开');
    a.href = d.url;
    a.target = '_blank';
    a.rel = 'noopener';
    wrap.appendChild(a);
    box.appendChild(wrap);
  }

  /**
   * 纯文本 / 代码：行号 + 等宽，不做语法高亮。
   * 为什么不高亮：项目里没有 highlight.js，自己按关键字正则着色会把
   * 注释里的词、字符串里的标识符染错 —— 错着色比不着色更难读。
   */
  function pvRenderText(box, d) {
    const lines = d.content.split('\n');
    const shown = lines.slice(0, PV_MAX_LINES);
    const wrap = el('div', 'pv-code-wrap');
    const gutter = el('div', 'pv-gutter', shown.map((_, i) => i + 1).join('\n'));
    const pre = el('pre', 'pv-code');
    pre.textContent = shown.join('\n');
    wrap.appendChild(gutter);
    wrap.appendChild(pre);
    box.appendChild(wrap);
    if (lines.length > PV_MAX_LINES) {
      pvTruncNote(box, { size: d.size, truncated: true });
    } else if (d.truncated) {
      pvTruncNote(box, d);
    }
  }

  function pvTruncNote(box, d) {
    box.appendChild(el('div', 'pv-trunc-note',
      '只显示前一部分（原文件 ' + fmtSize(d.size) + '）。完整内容请用其它方式查看。'));
  }

  // ── 展开 / 定位 / 拖拽 ────────────────────────────────────────

  async function pvSetOpen(open) {
    pv.open = open;
    const dock = $('#preview-dock');
    const btn = $('#preview-toggle-btn');
    if (!dock) return;
    dock.hidden = !open;
    // 收起时一并退出放大态：否则下次打开会莫名其妙占满整屏。
    if (!open) pvSetMax(false);
    // 面板挂在栏里，栏都收了就不该留着 aria-expanded=true
    if (!open && pvRoot.open) pvRootOpen(false);
    if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    pvSave();
    if (open && !pv.children.has(pv.cwd)) await pvLoadDir(pv.cwd);
  }

  /**
   * 把 pv.max / pv.full 落成 DOM —— 所有改状态的入口最后都走这里，
   * class、按钮图标、aria、分隔条方向都在这一处同步，不会各改各的。
   *
   * 三档：dock（窄栏竖排）→ max（铺满正文区，横排，目录在右）→ full（铺满
   * 整个窗口，无目录）。full 隐含 max（DOM 上两个 class 同时在），所以全屏态
   * 天然继承放大态的定位与布局，不必重复写一套。
   */
  function pvApplyMode() {
    const dock = $('#preview-dock');
    if (!dock) return;
    // 归一化：关栏时两档都退掉；full 必须站在 max 上
    if (!pv.open || !pv.max) pv.full = false;
    pv.max = !!pv.max && pv.open;
    dock.classList.toggle('is-max', pv.max);
    dock.classList.toggle('is-full', pv.full);

    const maxBtn = $('#pv-max-btn');
    if (maxBtn) {
      maxBtn.setAttribute('aria-pressed', pv.max ? 'true' : 'false');
      maxBtn.title = pv.max ? '还原预览（Esc）' : '放大预览（Esc 退出）';
      maxBtn.setAttribute('aria-label', pv.max ? '还原预览栏' : '放大预览');
    }
    const fullBtn = $('#pv-full-btn');
    if (fullBtn) {
      fullBtn.setAttribute('aria-pressed', pv.full ? 'true' : 'false');
      fullBtn.title = pv.full ? '退出全屏（Esc）' : '全屏阅读（隐藏目录，Esc 退出）';
      fullBtn.setAttribute('aria-label', pv.full ? '退出全屏阅读' : '全屏阅读');
    }
    // 分隔条换轴：竖排调树高（上下键），横排调目录列宽（左右键）
    const sp = $('#pv-split');
    if (sp) {
      sp.setAttribute('aria-orientation', pv.max ? 'vertical' : 'horizontal');
      sp.title = pv.max ? '拖动调整目录列宽度' : '拖动调整高度';
      sp.setAttribute('aria-label',
        pv.max ? '调整目录列宽度' : '调整文件树与预览区的高度');
    }
    pvSave();
  }

  /**
   * 放大 / 还原预览栏。
   *
   * 只切 class（`#preview-dock.is-max` 把它变成 absolute; inset:0），
   * **不动 --pv-w** —— 于是"退出放大"不需要记住并恢复宽度，用户之前拖出来的
   * 宽度天然还在，也不会有"恢复时算错一次"的状态可丢。
   *
   * 也正因为是绝对定位而不是把 flex-basis 加到 100%：后者会把聊天列挤成 0 却
   * 仍参与布局（composer 被推到屏幕外、消息区宽度抖动），盖上去则视觉层干净。
   */
  function pvSetMax(on) {
    pv.max = !!on && pv.open;
    if (!pv.max) pv.full = false; // 退出放大 = 连全屏一起退
    pvApplyMode();
  }

  /**
   * 全屏阅读 / 退出全屏：放大态之上再收掉目录，整屏只剩正文。
   * 退出全屏回到放大态（而不是一路退回窄栏）—— 用户刚才是从放大点进来的，
   * 按 Esc 逐级退比一键跳两级更符合预期。
   */
  function pvSetFull(on) {
    if (on) {
      if (!pv.open) return;
      pv.max = true;
    }
    pv.full = !!on && pv.open && pv.max;
    pvApplyMode();
  }

  /**
   * 定位到指定文件：逐级展开父目录并加载内容。
   * 工具卡点击时走这条路径 —— 用户看到 agent 刚读了哪个文件，一键就能看原文。
   */
  async function pvRevealPath(path) {
    if (!path) return false;
    const rel = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!pv.open) await pvSetOpen(true);
    const parts = rel.split('/').filter(Boolean);
    let cur = '.';
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur === '.' ? parts[i] : cur + '/' + parts[i];
      pv.expanded.add(cur);
      await pvLoadDir(next);
      cur = next;
    }
    pv.cwd = cur;
    pvRenderCrumbs();
    await pvLoadDir(cur);
    pv.current = { path: rel, name: parts[parts.length - 1] || rel };
    await pvOpenFile(rel);
    // 把选中项滚进视野（树可能很长）
    const tree = $('#pv-tree');
    if (tree) {
      const hit = Array.from(tree.querySelectorAll('.pv-item.is-active'))[0];
      if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }

  /** 通用拖拽：pointer 事件 + setPointerCapture，鼠标/触屏/触控笔同一条路径 */
  function pvDrag(handle, onMove) {
    const dock = $('#preview-dock');
    let active = false;
    handle.addEventListener('pointerdown', (e) => {
      active = true;
      handle.setPointerCapture(e.pointerId);
      dock.classList.add('is-resizing');
      handle.classList.add('is-dragging');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (active) onMove(e); });
    const end = (e) => {
      if (!active) return;
      active = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      dock.classList.remove('is-resizing');
      handle.classList.remove('is-dragging');
      pvSave();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ════════════════════════════════════════════════════════════
  // 会话模式菜单（权限档位 + 目标模式）—— 输入框下沿那颗按钮
  // ════════════════════════════════════════════════════════════
  // 后端真源是 mode 域（mode.get / setProfile / enterGoal / exitGoal），状态挂在 loop 上、
  // 随 <sessionDir>/allowlist.json 持久化 ⇒「这个会话放开、那个会话收紧」成立，
  // 切会话后打开菜单即重新拉一次（loadHistory 也会刷一遍）。
  //
  // 四档顺序与后端 PERMISSION_PROFILES 一致：从最克制到最放开。full 单独标红 ——
  // 它是唯一"从此不再问"的档位，用户必须一眼看出自己正踩在它上面。
  const MODE_DEFS = [
    { id: 'plan', label: '计划模式', desc: '只能读，先给方案再动手', icon: 'list-tree' },
    { id: 'confirm', label: '变更前确认', desc: '改文件 / 跑命令前先问', icon: 'check-circle-2' },
    { id: 'auto', label: '自主模式', desc: '常规改动不问，越界才问', icon: 'zap' },
    { id: 'full', label: '完全访问', desc: '跳过所有确认（仅本会话）', icon: 'unlock', danger: true },
  ];
  const modeState = { profile: 'confirm', goal: null };
  let modeBusy = false;

  const modeDef = (id) => MODE_DEFS.find((d) => d.id === id) || MODE_DEFS[1];

  /** lucide 会把 <i data-lucide> 换成 svg；要换图标只能重建容器内容 */
  function modeIcon(host, name) {
    if (!host) return;
    host.innerHTML = '<i data-lucide="' + name + '"></i>';
  }
  function modeIcons() {
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* 图标缺失不影响功能 */ } }
  }

  function modeRenderButton() {
    const def = modeDef(modeState.profile);
    const label = $('#mode-btn-label');
    const btn = $('#mode-btn');
    if (!label || !btn) return;
    label.textContent = def.label;
    modeIcon($('#mode-btn-ico'), def.icon);
    btn.classList.toggle('is-danger', !!def.danger);
    btn.title = '本会话权限：' + def.label + '（点击切换）'
      + (modeState.goal && modeState.goal.active ? ' · 目标模式进行中' : '');
  }

  function modeRenderList() {
    const box = $('#mode-list');
    if (!box) return;
    box.innerHTML = '';
    for (const d of MODE_DEFS) {
      const active = modeState.profile === d.id;
      const b = el('button', 'mode-item' + (d.danger ? ' is-danger' : '') + (active ? ' is-active' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', active ? 'true' : 'false');
      b.dataset.profile = d.id;
      const ico = el('span', 'mode-item-ico');
      modeIcon(ico, d.icon);
      const body = el('span', 'mode-item-body');
      body.appendChild(el('span', 'mode-item-title', d.label));
      body.appendChild(el('span', 'mode-item-desc', d.desc));
      const chk = el('span', 'mode-item-check');
      modeIcon(chk, 'check');
      b.append(ico, body, chk);
      b.addEventListener('click', () => modeSetProfile(d.id));
      box.appendChild(b);
    }
  }

  function modeRenderGoal() {
    const g = modeState.goal;
    const active = !!(g && g.active);
    const badge = $('#mode-goal-badge');
    const form = $('#mode-goal-form');
    const box = $('#mode-goal-active');
    const obj = $('#mode-goal-objective');
    if (badge) badge.hidden = !active;
    if (form) form.hidden = active;
    if (box) box.hidden = !active;
    if (active && obj) obj.textContent = g.objective || '';
  }

  function modeSetError(msg) {
    const p = $('#mode-goal-error');
    if (!p) return;
    p.textContent = msg || '';
    p.hidden = !msg;
  }

  function modeRender() {
    modeRenderButton();
    modeRenderList();
    modeRenderGoal();
    modeIcons();
  }

  /** 拉后端权威状态。失败时保持当前显示（菜单可用性优先于"显示精确"） */
  async function modeLoad() {
    try {
      const r = await client.request('mode.get');
      if (r && r.profile) {
        modeState.profile = r.profile;
        modeState.goal = r.goal || null;
        modeRender();
      }
    } catch (e) { /* loop 还没就绪 / 断连：保持上次显示 */ }
  }

  async function modeSetProfile(id) {
    if (modeBusy) return;
    if (id === modeState.profile) { modeOpen(false); return; }
    modeBusy = true;
    modeSetError('');
    try {
      const r = await client.request('mode.setProfile', { profile: id });
      if (r && r.profile) {
        modeState.profile = r.profile;
        modeState.goal = r.goal || modeState.goal;
        modeRender();
        modeOpen(false);   // 切完即收，用户意图已完成
      }
    } catch (e) {
      // 失败**不关闭**：错误文案要留在菜单里（关闭后用户只会以为"点了没反应"）
      modeSetError('切换失败：' + (e && e.message ? e.message : e));
      modeRender();
    } finally {
      modeBusy = false;
    }
  }

  async function modeEnterGoal() {
    const inp = $('#mode-goal-input');
    const objective = ((inp && inp.value) || '').trim();
    if (!objective) {
      modeSetError('先写一个目标');
      if (inp) inp.focus();
      return;
    }
    if (modeBusy) return;
    modeBusy = true;
    modeSetError('');
    try {
      const r = await client.request('mode.enterGoal', { objective });
      if (r && r.ok) {
        if (inp) inp.value = '';
        await modeLoad();   // 拿后端快照（enteredAt / enteredBy 等以服务端为准）
      } else {
        modeSetError((r && r.error) || '进入失败');
      }
    } catch (e) {
      modeSetError('进入失败：' + (e && e.message ? e.message : e));
    } finally {
      modeBusy = false;
    }
  }

  async function modeExitGoal() {
    if (modeBusy) return;
    modeBusy = true;
    modeSetError('');
    try {
      await client.request('mode.exitGoal', { reason: '用户在模式菜单里解除' });
      await modeLoad();
    } catch (e) {
      modeSetError('解除失败：' + (e && e.message ? e.message : e));
    } finally {
      modeBusy = false;
    }
  }

  /**
   * 把弹层左边缘对到按钮左边缘。
   * 为什么不在 CSS 里写死 left：输入区是 max-width 居中的，按钮的横坐标随窗口宽度变化
   * （1440 下差 40px，窄屏差 0），写死任何值都只在某一个宽度上对齐。
   */
  function modePosition() {
    const pop = $('#mode-pop');
    const btn = $('#mode-btn');
    const host = $('#chat-composer');
    if (!pop || !btn || !host) return;
    const b = btn.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const left = Math.round(b.left - h.left);
    // 别让弹层从容器左边缘探出去（窄屏 + 长文案时）
    pop.style.left = Math.max(8, left) + 'px';
  }

  function modeOpen(on) {
    const pop = $('#mode-pop');
    const btn = $('#mode-btn');
    if (!pop || !btn) return;
    const next = !!on;
    pop.hidden = !next;
    btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      modeSetError('');
      modePosition();
      void modeLoad();  // 每次打开都对齐一次：切过会话 / TUI 改过档位都能反映出来
    }
  }

  function bindModeMenu() {
    const btn = $('#mode-btn');
    const pop = $('#mode-pop');
    if (!btn || !pop) return;

    modeRender();
    void modeLoad();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      modeOpen(pop.hidden);
    });
    // 弹层内部的点击不能冒到 document 上（否则刚点开就被"点外部关闭"收掉）
    pop.addEventListener('click', (e) => e.stopPropagation());
    // 移出整个弹层（含右侧详情卡，DOM 上是 pop 子节点 ⇒ 进详情不触发）即收起详情，
    // 避免详情卡一直悬浮在界面上关不掉（2026-10-28 孑遗报）
    pop.addEventListener('mouseleave', () => {
      const d = $('#model-detail');
      if (d) d.hidden = true;
      $('#model-list .model-item').forEach((x) => x.classList.remove('is-hover'));
    });
    document.addEventListener('click', () => { if (!pop.hidden) modeOpen(false); });
    // rAF 再算一次：resize 回调可能落在布局完成前一帧，读到的还是旧坐标
    //（实测在切换设备尺寸时会把弹层放到偏右 130px 的位置）
    window.addEventListener('resize', () => {
      if (pop.hidden) return;
      requestAnimationFrame(modePosition);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) {
        e.stopPropagation();
        modeOpen(false);
      }
    });

    const start = $('#mode-goal-start');
    if (start) start.onclick = () => modeEnterGoal();
    const exit = $('#mode-goal-exit');
    if (exit) exit.onclick = () => modeExitGoal();
    const inp = $('#mode-goal-input');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        // Enter 提交目标，且**不要**冒泡到全局快捷键（否则会被当成"发送消息"）
        if (e.key === 'Enter') { e.preventDefault(); modeEnterGoal(); }
        e.stopPropagation();
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // 显示设置（思考过程 / 工具调用 / 时间戳）—— 纯前端偏好
  // ════════════════════════════════════════════════════════════
  // 与模式菜单的区别：那边改的是"agent 怎么干活"（会让后端行为变化），
  // 这边只改"这些东西给不给我看"。所以不写协议、不进 loop，只落 localStorage。
  //
  // 实现上只给 #message-list 加类、不删节点：流式渲染随时在插入新节点，
  // 删掉的下一条又会补回来；class 是"当前视图口径"，新节点自动继承。
  const VIEW_KEY = 'hyacinth.view';
  const viewPrefs = { thinking: true, tools: true, time: true };

  function viewApply() {
    const ml = $('#message-list');
    if (ml) {
      ml.classList.toggle('hide-thinking', !viewPrefs.thinking);
      ml.classList.toggle('hide-tools', !viewPrefs.tools);
      ml.classList.toggle('hide-time', !viewPrefs.time);
    }
    $$('#view-pop .view-item').forEach((b) => {
      const on = !!viewPrefs[b.dataset.view];
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function viewSave() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewPrefs)); } catch (e) { /* 隐私模式：不持久化也能用 */ }
  }

  function viewLoad() {
    try {
      const s = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
      if (!s || typeof s !== 'object') return;
      for (const k of Object.keys(viewPrefs)) {
        if (typeof s[k] === 'boolean') viewPrefs[k] = s[k];
      }
    } catch (e) { /* 坏数据：全开 */ }
  }

  function viewSetOpen(on) {
    const pop = $('#view-pop');
    const btn = $('#view-btn');
    if (!pop || !btn) return;
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function bindViewMenu() {
    const btn = $('#view-btn');
    const pop = $('#view-pop');
    if (!btn || !pop) return;

    viewLoad();
    viewApply();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      viewSetOpen(pop.hidden);
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (!pop.hidden) viewSetOpen(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) {
        e.stopPropagation();
        viewSetOpen(false);
      }
    });

    $$('#view-pop .view-item').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.view;
        if (!(k in viewPrefs)) return;
        viewPrefs[k] = !viewPrefs[k];
        viewApply();
        viewSave();
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // 模型选择器（输入框右下角）：列表 + 悬停二级菜单
  // ════════════════════════════════════════════════════════════
  // 分工：列表只负责"选哪个"；二级菜单承载"这个模型能干什么"（上下文 / 是否支持思考 /
  // 价格）与唯一真正可调的旋钮（思考强度）。每行都塞满元信息会让 10 个模型变成一堵墙。
  const EFFORT_DEFS = [
    { id: 'off', label: '关' },
    { id: 'minimal', label: '极低' },
    { id: 'low', label: '低' },
    { id: 'medium', label: '中' },
    { id: 'high', label: '高' },
    { id: 'max', label: '最高' },
  ];
  const modelPick = {
    models: [],
    /** 已配置密钥的厂商（来自 model.listProviders）；空集 = 不限制 */
    ready: new Set(),
    provider: '',
    model: '',
    effort: 'medium',
    busy: false,
  };

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (Math.round(v / 100000) / 10) + 'M';
    if (v >= 1024) return Math.round(v / 1024) + 'K';
    return String(v);
  }

  function modelPickLabel() {
    const hit = modelPick.models.find((x) => x.provider === modelPick.provider && x.id === modelPick.model);
    return hit ? hit.name : (modelPick.model || '模型');
  }

  function renderModelPickButton() {
    const name = $('#model-pick-name');
    if (name) name.textContent = modelPickLabel();
  }

  function renderModelList() {
    const box = $('#model-list');
    const cnt = $('#model-pop-count');
    if (!box) return;
    box.innerHTML = '';
    let shown = 0;
    if (!modelPick.models.length) {
      box.appendChild(el('div', 'model-item-meta', '暂无可用模型（先到模型页配置提供商密钥）'));
      if (cnt) cnt.textContent = '';
      return;
    }
    for (const m of modelPick.models) {
      const active = m.provider === modelPick.provider && m.id === modelPick.model;
      // 只显示已配置密钥的厂商的模型（当前活跃永远保留）—— 列表更干净（2026-10-28 孑遗要求）
      if (modelPick.ready.size > 0 && !modelPick.ready.has(m.provider) && !active) continue;
      shown++;
      // 不按"是否配了密钥"禁用列表项：listProviders 的 configured 是**启发式**
      // （没有 envKey 的在线厂商会被误判为已配置 —— 实测 commandcode 就是如此），
      // 拿它当门禁会出现"看着能点、点了报 Provider not found"或"能跑却灰着"。
      // 只在明显缺密钥时加一行提示，能不能切交给后端判，失败时给可操作的错误。
      const maybeUnconfigured = modelPick.ready.size > 0 && !modelPick.ready.has(m.provider) && !active;
      // is-muted 只是视觉弱化，不做禁用：configured 本身是启发式，禁错了比不禁更糟
      const b = el('button', 'model-item' + (active ? ' is-active' : '') + (maybeUnconfigured ? ' is-muted' : ''));
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.dataset.provider = m.provider;
      b.dataset.model = m.id;
      const main = el('span', 'model-item-main');
      main.appendChild(el('span', 'model-item-name', m.name));
      const meta = [m.provider, fmtTokens(m.contextWindow) + ' 上下文'];
      if (m.reasoning) meta.push('支持思考');
      if (m.status === 'preview') meta.push('预览');
      if (maybeUnconfigured) meta.push('未配置密钥');
      main.appendChild(el('span', 'model-item-meta', meta.join(' · ')));
      const chk = el('span', 'model-item-check');
      chk.innerHTML = '<i data-lucide="check"></i>';
      b.append(main, chk);
      b.addEventListener('click', () => switchModel(m.provider, m.id));
      b.addEventListener('mouseenter', () => showModelDetail(m, b));
      b.addEventListener('focus', () => showModelDetail(m, b));
      box.appendChild(b);
    }
    if (shown === 0) box.appendChild(el('div', 'model-item-meta', '暂无已配置密钥的模型（先到模型页配置提供商密钥）'));
    if (cnt) cnt.textContent = shown + ' 个';
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* 图标缺失不影响功能 */ } }
  }

  /** 二级菜单：内容随悬停项重建，位置按该项的 rect 算（CSS 做不到"跟着当前项"） */
  function showModelDetail(m, item) {
    const pop = $('#model-pop');
    const detail = $('#model-detail');
    if (!pop || !detail) return;
    $$('#model-list .model-item').forEach((x) => x.classList.toggle('is-hover', x === item));
    detail.hidden = false;
    detail.innerHTML = '';

    const title = el('div', 'model-detail-title');
    title.appendChild(el('span', '', m.name));
    if (m.status === 'preview') title.appendChild(el('span', 'model-detail-badge', '预览'));
    detail.appendChild(title);

    const bits = [];
    if (m.reasoning) bits.push('支持思考');
    bits.push('上下文 ' + fmtTokens(m.contextWindow));
    detail.appendChild(el('p', 'model-detail-desc',
      bits.join('，') + '。点一下左侧即切换；思考强度对之后发出的消息生效。'));

    const row = (k, v) => {
      const r = el('div', 'model-detail-row');
      r.appendChild(el('span', 'model-detail-key', k));
      r.appendChild(el('span', 'model-detail-val', v));
      return r;
    };
    detail.appendChild(row('厂商', m.provider));
    detail.appendChild(row('上下文窗口', fmtTokens(m.contextWindow)));
    detail.appendChild(row('单次最大输出', fmtTokens(m.maxOutputTokens)));
    if (m.cost) {
      detail.appendChild(row('价格 / 1M', '$' + m.cost.input + ' 入 · $' + m.cost.output + ' 出'));
    }

    // 思考强度只对**当前生效的模型**可调：setThinking 作用在活跃 provider 上，
    // 让用户在"Claude 的详情卡"里点档位、实际改掉 deepseek 的强度，是最难排查的那种错。
    // 非当前模型只展示它自己的默认档位，并说明切换后才可调。
    if (m.reasoning) {
      const isCurrent = m.provider === modelPick.provider && m.id === modelPick.model;
      const shown = isCurrent ? modelPick.effort : (m.reasoningEffort || 'medium');
      detail.appendChild(row('思考强度', isCurrent ? '点击切换' : '切换后可调'));
      const grp = el('div', 'model-effort');
      for (const d of EFFORT_DEFS) {
        const b = el('button', 'model-effort-btn' + (d.id === shown ? ' is-active' : ''), d.label);
        b.type = 'button';
        b.dataset.effort = d.id;
        if (!isCurrent) {
          b.disabled = true;
          b.classList.add('is-readonly');
        } else {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            setEffort(d.id);
          });
        }
        grp.appendChild(b);
      }
      detail.appendChild(grp);
    } else {
      detail.appendChild(el('p', 'model-detail-desc', '该模型不支持思考档位。'));
    }

    // 位置：贴当前项右侧；右边放不下就翻到左侧（1440 窗口下 pop 已经贴右缘，必然翻左）
    const pr = pop.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    detail.style.top = Math.max(6, Math.round(ir.top - pr.top)) + 'px';
    detail.classList.toggle('is-left', pr.right + 272 > window.innerWidth);
  }

  async function modelPickLoad() {
    try {
      const [list, act, provs] = await Promise.all([
        client.request('model.listModels'),
        client.request('model.getActive').catch(() => null),
        client.request('model.listProviders').catch(() => null),
      ]);
      if (act) {
        modelPick.provider = act.provider || modelPick.provider;
        modelPick.model = act.model || modelPick.model;
      }
      // 当前厂商排最前：58 个模型平铺时，若按字母序当前项会掉到第 7 屏外的位置，
      // 每次打开都要先滚一段才能确认"我在用什么"
      const curProv = modelPick.provider;
      const curModel = modelPick.model;
      modelPick.models = ((list && list.models) || []).slice().sort((a, b) => {
        // 当前模型 > 当前厂商的其它模型 > 其余（各自按名字）
        const rank = (m) => (m.provider === curProv ? (m.id === curModel ? 0 : 1) : 2);
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return (a.provider + a.name).localeCompare(b.provider + b.name);
      });
      // 哪些厂商真的有密钥（或本地就绪）：只用于给"未配置"的项加一层弱化提示。
      // 空集不启用限制 —— 万一 listProviders 不可用，宁可让人试一次也别把整张表标灰。
      modelPick.ready = new Set(
        ((provs && provs.providers) || []).filter((p) => p.configured).map((p) => p.type),
      );
      const cur = modelPick.models.find((x) => x.provider === modelPick.provider && x.id === modelPick.model);
      if (cur && cur.reasoningEffort) modelPick.effort = cur.reasoningEffort;
      renderModelPickButton();
      renderModelList();
    } catch (e) { /* 断连时保持上次文案，不打断对话 */ }
  }

  async function switchModel(provider, model) {
    if (modelPick.busy) return;
    if (provider === modelPick.provider && model === modelPick.model) {
      modelPickOpen(false);
      return;
    }
    modelPick.busy = true;
    try {
      await client.request('model.switch', { provider, model });
      modelPick.provider = provider;
      modelPick.model = model;
      renderModelPickButton();
      renderModelList();
      refreshState();
      appendMsg('system', '已切换模型：' + modelPickLabel());
      modelPickOpen(false);
    } catch (e) {
      const msg = (e && e.message) || '未知错误';
      // "Provider xxx not found" 是**配置缺失**，不是模型问题：给出下一步动作，
      // 否则用户只会反复点同一个条目
      appendMsg('error', /not found/i.test(msg)
        ? `切换失败：厂商「${provider}」尚未配置。到「模型选择」页添加该提供商，再回来切换。`
        : '切换模型失败: ' + msg);
    } finally {
      modelPick.busy = false;
    }
  }

  /** 思考强度：与模型页的 radio 共用同一套档位，改一处两边都跟着动 */
  function syncThinkingUI(id) {
    modelPick.effort = id;
    $$('#model-detail .model-effort-btn').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.effort === id);
    });
  }

  async function setEffort(id) {
    const enabled = id !== 'off';
    try {
      await client.request('model.setThinking', { enabled, effort: enabled ? id : undefined });
      syncThinkingUI(id);
      $$('input[name="reasoning"]').forEach((r) => { r.checked = r.value === id; });
      const descEl = $('#model-reasoning-desc');
      if (descEl && REASONING_DESC[id]) descEl.textContent = REASONING_DESC[id];
    } catch (e) {
      appendMsg('error', '设置思考强度失败: ' + ((e && e.message) || '未知错误'));
    }
  }

  /** 弹层定位：锚定按钮 rect、向上弹出（fixed 定位，见 .model-pop 的 CSS 注释 ——
   *  必须脱离 #hyacinth-main 的 overflow:hidden，否则窄主区下右半被裁）。
   *  横向贴按钮右缘对齐（与旧 right:24 的视觉一致），越界时收进视口。 */
  function positionModelPop() {
    const pop = $('#model-pop');
    const btn = $('#model-pick-btn');
    if (!pop || !btn || pop.hidden) return;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 320;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    pop.style.left = Math.round(left) + 'px';
    pop.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
    pop.style.top = 'auto';
  }

  function modelPickOpen(on) {
    const pop = $('#model-pop');
    const btn = $('#model-pick-btn');
    if (!pop || !btn) return;
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) {
      positionModelPop();
      void modelPickLoad();
    } else {
      const detail = $('#model-detail');
      if (detail) { detail.hidden = true; detail.innerHTML = ''; }
      $$('#model-list .model-item').forEach((x) => x.classList.remove('is-hover'));
    }
  }

  // ════════════════════════════════════════════════════════════
  // 语音输入（stt 契约域：本地 SenseVoice 转写）
  // ════════════════════════════════════════════════════════════
  // 交互：点击麦克风开始录音，再点结束 → 前端解码/重采样成 16kHz 单声道
  // PCM WAV（后端零解码依赖）→ stt.transcribe → 文本插入输入框**光标处**
  // （不直接发送，用户可改后回车）。录音频是"私彩"数据：只在内存里走一圈，
  // 转写完即弃（契约层不落盘）。
  const sttState = {
    phase: 'idle',        // idle | recording | transcribing
    recorder: null,
    stream: null,
    chunks: [],
    startedAt: 0,
    timer: null,
    sharedCtx: null,      // 16kHz AudioContext（复用，避免每次开关创建）
    modelDownloading: false,
  };

  function sttBtnSet(phase, hint) {
    sttState.phase = phase;
    const btn = $('#stt-btn');
    if (!btn) return;
    btn.classList.toggle('is-recording', phase === 'recording');
    btn.classList.toggle('is-busy', phase === 'transcribing');
    const tips = {
      idle: '语音输入（点击开始，再点结束并转写）',
      recording: '录音中… 点击结束并转写',
      transcribing: hint || '转写中…',
    };
    btn.title = tips[phase] || tips.idle;
    btn.setAttribute('aria-label', tips[phase] || tips.idle);
  }

  /** 解码录音 blob → 16kHz 单声道 Float32（AudioContext 指定采样率即完成重采样） */
  async function sttDecodeTo16k(blob) {
    // 按需创建、用完即关：常驻 AudioContext 会让进程持续持有音频设备（2026-10-31 排查麦克风占用）
    const ctx = new AudioContext({ sampleRate: 16000 });
    try {
      const buf = await blob.arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      // 多声道混到单声道
      const ch = audio.numberOfChannels;
      const out = new Float32Array(audio.length);
      for (let c = 0; c < ch; c++) {
        const data = audio.getChannelData(c);
        for (let i = 0; i < data.length; i++) out[i] += data[i] / ch;
      }
      return { samples: out, sampleRate: audio.sampleRate };
    } finally {
      try { await ctx.close(); } catch (e) { /* ignore */ }
    }
  }

  /** Float32 → 16bit PCM WAV（服务端 stt/wav.ts 只认这个） */
  function sttEncodeWav(samples, sampleRate) {
    const data = new DataView(new ArrayBuffer(samples.length * 2));
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      data.setInt16(i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    const header = new ArrayBuffer(44);
    const h = new DataView(header);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) h.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); h.setUint32(4, 36 + data.byteLength, true); str(8, 'WAVE');
    str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * 2, true);
    h.setUint16(32, 2, true); h.setUint16(34, 16, true);
    str(36, 'data'); h.setUint32(40, data.byteLength, true);
    return new Blob([header, data], { type: 'audio/wav' });
  }

  /** 把转写文本插入输入框**光标处**（前接一个空格避免粘连），保持焦点与光标在插入尾部 */
  function sttInsertText(text) {
    const ta = $('#chat-input');
    if (!ta) return;
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    const prefix = s > 0 && !/[\s\n]$/.test(ta.value.slice(0, s)) ? ' ' : '';
    ta.setRangeText(prefix + text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(s + (prefix + text).length, s + (prefix + text).length);
  }

  function sttCleanup() {
    try { sttState.recorder?.state !== 'inactive' && sttState.recorder?.stop(); } catch (e) { /* ignore */ }
    sttState.stream?.getTracks().forEach((t) => t.stop());
    sttState.stream = null;
    sttState.recorder = null;
    sttState.chunks = [];
    if (sttState.timer) { clearInterval(sttState.timer); sttState.timer = null; }
  }

  async function sttToggle() {
    const btn = $('#stt-btn');
    if (!btn || sttState.phase === 'transcribing') return;

    // 设置页开关联动：stt.enabled=false 时按钮只提示（状态即时查，不依赖事件）
    try {
      const cfg = await client.request('config.get', { path: 'stt.enabled' });
      if (cfg && cfg.value === false) {
        btn.title = '语音输入已在设置中禁用（设置 → 语音）';
        appendMsg('status', '语音输入已在设置中禁用 —— 设置 → 语音 可重新开启');
        return;
      }
    } catch (e) { /* config 查询失败不拦输入（默认启用） */ }

    if (sttState.phase === 'idle') {
      try {
        sttState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const why = err && err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝 —— 请在浏览器/系统设置里放行本站点'
          : `无法访问麦克风：${(err && err.message) || err}`;
        sttBtnSet('idle');
        btn.title = why;
        appendMsg('error', '语音输入不可用：' + why);
        return;
      }
      sttState.chunks = [];
      sttState.recorder = new MediaRecorder(sttState.stream);
      sttState.recorder.ondataavailable = (e) => { if (e.data.size) sttState.chunks.push(e.data); };
      sttState.recorder.onstop = () => { void sttFinishRecording(); };
      sttState.recorder.start();
      sttState.startedAt = Date.now();
      sttBtnSet('recording');
      sttState.timer = setInterval(() => {
        const s = Math.floor((Date.now() - sttState.startedAt) / 1000);
        btn.title = `录音中 ${s}s… 点击结束并转写`;
      }, 500);
      return;
    }

    // recording → 停止并转写（onstop 回调接管）
    if (sttState.phase === 'recording') {
      const elapsed = Date.now() - sttState.startedAt;
      if (elapsed < 400) {
        // 误触保护：过短按不出有效语音，直接放弃
        sttCleanup();
        sttBtnSet('idle');
        return;
      }
      sttBtnSet('transcribing');
      sttState.recorder?.stop();
      sttState.stream?.getTracks().forEach((t) => t.stop());
    }
  }

  async function sttFinishRecording() {
    // 录音已结束：立即释放麦克风轨道（tracks）并清引用，避免设备被 WebView2 持续持有（2026-10-31）
    try { sttState.stream?.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    const blob = new Blob(sttState.chunks, { type: sttState.chunks[0]?.type || 'audio/webm' });
    sttState.chunks = [];
    if (sttState.timer) { clearInterval(sttState.timer); sttState.timer = null; }
    try {
      const { samples, sampleRate } = await sttDecodeTo16k(blob);
      const wav = sttEncodeWav(samples, sampleRate);
      const b64 = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1]);
        fr.readAsDataURL(wav);
      });
      const result = await client.request('stt.transcribe', { audioWavBase64: b64 });
      if (result && result.text) sttInsertText(result.text);
      else appendMsg('error', '语音转写结果为空');
      sttBtnSet('idle');
    } catch (err) {
      const msg = String((err && err.message) || err);
      sttBtnSet('idle');
      // 模型未下载：自动触发下载，进度经 stt.model_progress 事件反映在按钮 title
      if (/未下载|模型未就绪/.test(msg)) {
        sttBtnSet('transcribing', '正在下载语音模型…');
        sttState.modelDownloading = true;
        try { await client.request('stt.download'); } catch (e) { /* 事件里看错误 */ }
      } else {
        appendMsg('error', '语音转写失败：' + msg);
      }
    }
  }

  function bindSttButton() {
    const btn = $('#stt-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => { e.stopPropagation(); void sttToggle(); });
  }

  // ── 设置页「语音」分区（stt.status + config stt.enabled）──────────
  // 布局：启用开关卡 + 模型管理卡（状态/进度/下载/删除）。模型不入源码仓库，
  // 这里是它的生命周期管理面（下载/释放），麦克风按钮读 stt.enabled 联动。

  let voiceSettingsBound = false;

  async function loadVoiceSettings() {
    const stateEl = $('#stt-model-state');
    if (!stateEl) return;
    let st = null;
    try { st = await client.request('stt.status'); } catch (e) { st = null; }
    let enabled = true;
    try {
      const r = await client.request('config.get', { path: 'stt.enabled' });
      enabled = r ? r.value !== false : true;   // 键不存在视为启用（默认开）
    } catch (e) { /* 默认启用 */ }
    const toggle = $('#stt-enabled-toggle');
    if (toggle) toggle.checked = enabled;

    const dirEl = $('#stt-model-dir');
    if (dirEl) dirEl.textContent = st ? st.modelDir : '—';
    const rtEl = $('#stt-runtime-desc');
    if (rtEl) {
      rtEl.textContent = st
        ? (st.runtimeAvailable
          ? '已就绪（sherpa-onnx，本地推理）'
          : `不可用：${st.lastError || '未安装'} —— 执行 pnpm add sherpa-onnx-node 后重启`)
        : '—';
    }

    const downloadBtn = $('#stt-model-download');
    const removeBtn = $('#stt-model-remove');
    const progressRow = $('#stt-model-progress-row');
    const progressBar = $('#stt-model-progress-bar');
    const progressText = $('#stt-model-progress-text');

    if (!st) {
      stateEl.textContent = '不可用';
      if (downloadBtn) downloadBtn.disabled = true;
      if (removeBtn) removeBtn.disabled = true;
      return;
    }

    if (st.downloading) {
      // ⚠️ 下载态**无论有无 progress 数据**都要显示进度行并继续轮询 ——
      // 点击"下载"后引擎先置 downloading、首个进度回调要等 500ms 节流窗口，
      // 这段窗口 progress 是 undefined；若只在"有数据"时才轮询，轮询链在这里
      // 断裂，进度条永远出不来（实测踩过）。
      stateEl.textContent = '下载中…';
      if (progressRow) progressRow.hidden = false;
      const p = st.downloadProgress;
      if (progressBar) progressBar.style.width = (p?.percent || 0) + '%';
      if (progressText) {
        progressText.textContent = p
          ? `${p.file} · ${p.percent}% · ${(p.received / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB · ${p.speed}`
          : '准备中…';
      }
      if (downloadBtn) downloadBtn.disabled = true;
      if (removeBtn) removeBtn.disabled = true;
      setTimeout(() => { if (currentView() === 'settings') loadVoiceSettings(); }, 800);
      return;
    }

    if (progressRow) progressRow.hidden = true;
    if (st.modelReady) {
      stateEl.textContent = '已就绪';
      if (downloadBtn) downloadBtn.disabled = true;
      if (removeBtn) removeBtn.disabled = false;
    } else {
      stateEl.textContent = st.runtimeAvailable ? '未下载' : '不可用';
      if (downloadBtn) downloadBtn.disabled = !st.runtimeAvailable;
      if (removeBtn) removeBtn.disabled = true;
      if (st.lastError && progressText) {
        if (progressRow) progressRow.hidden = false;
        if (progressBar) progressBar.style.width = '0%';
        progressText.textContent = '上次错误：' + st.lastError;
      }
    }
  }

  function bindVoiceSettingsOnce() {
    if (voiceSettingsBound) return;
    voiceSettingsBound = true;
    const toggle = $('#stt-enabled-toggle');
    if (toggle) toggle.addEventListener('change', async () => {
      try {
        await client.request('config.set', { path: 'stt.enabled', value: toggle.checked });
      } catch (e) {
        appendMsg('error', '保存语音输入开关失败：' + ((e && e.message) || e));
        toggle.checked = !toggle.checked;
      }
    });
    const download = $('#stt-model-download');
    if (download) download.addEventListener('click', async () => {
      download.disabled = true;
      try { await client.request('stt.download'); } catch (e) {
        appendMsg('error', '触发模型下载失败：' + ((e && e.message) || e));
        download.disabled = false;
      }
      void loadVoiceSettings();
    });
    const remove = $('#stt-model-remove');
    if (remove) remove.addEventListener('click', async () => {
      if (!window.confirm('删除已下载的语音模型（约 230MB）？删除后可随时重新下载。')) return;
      remove.disabled = true;
      try { await client.request('stt.remove'); } catch (e) {
        appendMsg('error', '删除语音模型失败：' + ((e && e.message) || e));
      }
      void loadVoiceSettings();
    });
    const radio = $('#tab-voice');
    if (radio) radio.addEventListener('change', () => { if (radio.checked) void loadVoiceSettings(); });
  }

  // ── 设置页「语音合成」（tts 契约域：CosyVoice3 环境/模型/服务）────────
  // python 环境与 torch/cosyvoice 包是外来环境（源码不携带），这里只做
  // 检测/指引；模型 base|rl 按需增量下载；推理服务按需启停；试听走合成。
  // 卡片本体由 say-voice 插件贡献（buildTtsCard，见插件贡献卡区），此处只剩数据面。

  /** 模型存储位置卡（生效目录显示 + config models.root 读写） */
  let modelsRootLoaded = false;
  async function loadModelsRoot() {
    const nowEl = $('#models-root-now');
    if (!nowEl) return;
    let dir = null;
    // stt.status.modelDir 已是解析后的生效目录（env > config > 默认）
    try { const s = await client.request('stt.status'); dir = s && s.modelDir; } catch (e) { /* 下略 */ }
    if (!dir) { try { const t = await client.request('tts.status'); dir = t && t.model && t.model.modelDir; } catch (e) { /* ignore */ } }
    nowEl.textContent = dir || '—';
    const input = $('#models-root-input');
    if (input && document.activeElement !== input && !modelsRootLoaded) {
      modelsRootLoaded = true;
      try {
        const r = await client.request('config.get', { path: 'models.root' });
        if (r && typeof r.value === 'string') input.value = r.value;
      } catch (e) { /* 默认空 */ }
    }
    // 下载源（models.mirror：''=auto | hf-mirror | huggingface）
    const mirrorSel = $('#models-mirror');
    if (mirrorSel && document.activeElement !== mirrorSel) {
      try {
        const r = await client.request('config.get', { path: 'models.mirror' });
        mirrorSel.value = (r && typeof r.value === 'string') ? r.value : '';
      } catch (e) { mirrorSel.value = ''; }
    }
  }

  function bindModelsRootOnce() {
    const save = $('#models-root-save');
    if (!save) return;
    save.addEventListener('click', async () => {
      const input = $('#models-root-input');
      if (!input) return;
      const v = input.value.trim();
      try {
        await client.request('config.set', { path: 'models.root', value: v });
        modelsRootLoaded = false;
        await loadModelsRoot();
        appendMsg('status', v ? '模型存储位置已保存：' + v + '（对之后的下载生效）' : '已恢复默认位置（~/.agent/models）');
      } catch (e) {
        appendMsg('error', '保存模型位置失败：' + ((e && e.message) || e));
      }
    });
    // 下载源切换：写 models.mirror，即时生效（下次下载按新源排序）
    const mirrorSel = $('#models-mirror');
    if (mirrorSel) mirrorSel.addEventListener('change', async () => {
      try {
        await client.request('config.set', { path: 'models.mirror', value: mirrorSel.value });
        appendMsg('status', '下载源已切换：' + (mirrorSel.value || 'auto（逐源尝试）'));
      } catch (e) {
        appendMsg('error', '保存下载源失败：' + ((e && e.message) || e));
      }
      void loadVoiceSettings();
      void loadTtsSettings();
    });
    const open = $('#models-root-open');
    if (open) open.addEventListener('click', () => {
      // WebUI 无 shell 能力：把生效路径复制到剪贴板（资源管理器直达由桌面壳/本地用户完成）
      const nowEl = $('#models-root-now');
      if (!nowEl || !nowEl.textContent || nowEl.textContent === '—') return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(nowEl.textContent)
          .then(() => appendMsg('status', '路径已复制：' + nowEl.textContent))
          .catch(() => appendMsg('status', '路径：' + nowEl.textContent));
      } else {
        appendMsg('status', '路径：' + nowEl.textContent);
      }
    });
  }

  async function loadTtsSettings() {
    const stateEl = $('#tts-service-state');
    if (!stateEl) return;
    // 引擎信息每轮重测：先清空，失败时才能真退回 cosyvoice 视角。
    // 不清的话，清理父进程后 dataset 会留着上轮的 breeze，界面拿旧就绪度继续显示。
    delete stateEl.dataset.engineKind;
    delete stateEl.dataset.engineReady;
    // 引擎选择（「say 接在哪个」）—— 独立于 cosyvoice 服务状态：
    // 选了在线引擎时本地服务本来就不该跑，不能因为 status 失败就不显示引擎。
    try {
      const eng = await client.request('tts.engines');
      const sel = $('#tts-engine');
      const desc = $('#tts-engine-desc');
      if (sel && eng && Array.isArray(eng.engines)) {
        if (document.activeElement !== sel) {
          sel.innerHTML = eng.engines
            .map((e) => '<option value="' + e.kind + '">' + e.label + (e.ready ? '' : '（未就绪）') + '</option>')
            .join('');
          sel.value = eng.active;
        }
        const cur = eng.engines.find((e) => e.kind === eng.active);
        if (desc && cur) {
          desc.textContent =
            (cur.ready ? '就绪' : '未就绪') + ' · ' + cur.detail +
            ' · 能力：' + (cur.capabilities.emotion ? '情绪✓' : '情绪✗') +
            ' ' + (cur.capabilities.speed ? '语速✓' : '语速✗');
        }
        // 把「当前引擎」与「它是否就绪」带出 try 块 —— 下面的头部徽标和试听按钮
        // 都要按引擎分流，而 tts.status 返回的是 **cosyvoice 视角**的模型/服务状态。
        // 不带出来的话，切到 breeze 后会拿 CosyVoice 的「未运行」去禁用试听按钮、
        // 去点亮头部徽标 —— 明明 breeze 能用，界面却报不可用。
        if (eng && eng.active) {
          stateEl.dataset.engineKind = eng.active;
          const curReady = eng.engines?.find?.((e) => e.kind === eng.active)?.ready;
          stateEl.dataset.engineReady = curReady ? '1' : '0';
        }
        // 在线引擎配置表单：只在该引擎被选中时出现（选了在线却无处填 key = 死路）
        const onlineBlock = $('#tts-online-block');
        if (onlineBlock) onlineBlock.hidden = eng.active !== 'online';
        // CosyVoice3 专属区（模型下载 / python / 推理服务）：只在选中 cosyvoice3 时显示。
        // 【这是哪个坑的修法】切到 breeze 后，「下载」按钮走 tts.download → cosyvoice 单例，
        // 点下去会拉 3.7GB 的 CosyVoice3 权重，界面上却毫无提示 —— 用户以为是给当前引擎下模型。
        // 这些控件对 breeze 完全无效，留着只会误导。
        const cosyBlock = $('#tts-cosyvoice-block');
        if (cosyBlock) cosyBlock.hidden = eng.active !== 'cosyvoice3';
        // breeze 本地引擎配置：同理，只在选中 breeze-tts-2 时出现。
        // 回填与显隐放在一起（不是另开一个 try）—— 它们本就是「当前选中谁」这一件事。
        const breezeBlock = $('#tts-breeze-block');
        if (breezeBlock) {
          breezeBlock.hidden = eng.active !== 'breeze-tts-2';
          if (!breezeBlock.hidden) {
            try {
              const bc = await client.request('tts.breezeConfig');
              const setVal = (sel, v) => { const n = $(sel); if (n && document.activeElement !== n) n.value = v ?? ''; };
              setVal('#tts-breeze-clipath', bc.cliPath);
              setVal('#tts-breeze-modelpath', bc.modelPath);
              setVal('#tts-breeze-backend', bc.backend);
              setVal('#tts-breeze-device', bc.device);
              setVal('#tts-breeze-port', bc.serverPort);
              const auto = $('#tts-breeze-autostart');
              if (auto) auto.checked = bc.serverAutoStart === true;
              // 路径存在性：绿 ✓ / 红 ✗ —— 「填了」和「能用」是两件事，
              // 只回显字符串的话界面看着正常、点了才报错。
              const paint = (id, ok) => {
                const n = $(id);
                if (!n) return;
                n.textContent = ok ? '✓ 存在' : '✗ 找不到';
                n.style.color = ok ? 'var(--hyacinth-ok,#22c55e)' : 'var(--hyacinth-danger,#ef4444)';
              };
              paint('#tts-breeze-cli-flag', bc.cliExists);
              paint('#tts-breeze-model-flag', bc.modelExists);
              const bDesc = $('#tts-breeze-desc');
              if (bDesc) bDesc.textContent = bc.detail;
            } catch (e) {
              // breeze 配置读取失败不该拦住下面模型/python/服务区块的渲染
            }
          }
        }
      }
    } catch (e) {
      // 引擎清单不可用不应影响下面模型/python/服务几个区块的渲染
    }
    // 在线引擎配置回填（与引擎清单分开：表单要能独立加载，不因清单失败而不显示）
    try {
      if (!$('#tts-online-block')?.hidden) {
        const oc = await client.request('tts.onlineConfig');
        const setVal = (sel, v) => { const n = $(sel); if (n && document.activeElement !== n) n.value = v ?? ''; };
        setVal('#tts-online-provider', oc.provider);
        setVal('#tts-online-baseurl', oc.baseUrl);
        setVal('#tts-online-model', oc.model);
        setVal('#tts-online-voice', oc.voice);
        setVal('#tts-online-language', oc.language);
        setVal('#tts-online-format', oc.format);
        setVal('#tts-online-timeout', oc.timeoutMs || '');
        // 密钥永不回填明文：只报「有没有 / 从哪来」
        const keyInput = $('#tts-online-apikey');
        if (keyInput && document.activeElement !== keyInput) keyInput.value = '';
        const keyState = $('#tts-online-key-state');
        if (keyState) {
          keyState.textContent = oc.hasApiKey
            ? (oc.apiKeySource === 'config' ? '已配置密钥（config.json）' : '已配置密钥（环境变量 ' + oc.apiKeySource.replace('env:', '') + '）')
            : '未配置密钥 —— 填下面这一栏才能用在线引擎';
        }
        if (keyInput) keyInput.placeholder = oc.hasApiKey ? '留空 = 不修改（已配置）' : '粘贴 API key';
        // 「清除」只在**配置文件里真有密钥**时出现。
        // 环境变量来的密钥删不掉（那是 .env / 系统环境），显示按钮只会误导。
        const clearBtn = $('#tts-online-apikey-clear');
        if (clearBtn) clearBtn.style.display = oc.apiKeySource === 'config' ? '' : 'none';
      }
    } catch (e) {
      // 与引擎清单同理：在线配置不可用不影响其它区块
    }
    let st = null;
    try { st = await client.request('tts.status'); } catch (e) { st = null; }
    if (!st) {
      stateEl.textContent = '不可用';
      return;
    }
    const m = st.model || {};
    // variant 下拉（不回写触发下载 —— 下载点按钮）
    const variantSel = $('#tts-variant');
    if (variantSel && document.activeElement !== variantSel) variantSel.value = m.variant || 'rl';
    // 模型状态
    const descEl = $('#tts-model-desc');
    if (descEl) {
      if (m.downloading && m.downloadProgress) {
        descEl.textContent = `下载中 ${m.downloadProgress.file} · ${m.downloadProgress.percent}%`;
      } else {
        descEl.textContent = m.ready
          ? `已就绪（variant=${m.variant}）`
          : `未就绪 —— 缺 ${m.missingFiles.length} 个文件（${(m.missingFiles[0] || '')}${m.missingFiles.length > 1 ? ' 等' : ''}）`;
      }
    }
    const dlBtn = $('#tts-model-download');
    // 下载按钮：模型与 python 依赖都就绪才禁用 —— 「一键就绪」两阶段，
    // 模型齐但依赖缺时按钮保留（点它自动补依赖：克隆仓库 + pip 裁剪集）
    if (dlBtn) dlBtn.disabled = !!m.downloading || (m.ready && st.python?.cosyvoiceInstalled === true);
    const progressRow = $('#tts-progress-row');
    // ⚠️ 下载态无论有无 progress 数据都显示进度行并继续轮询（同 loadVoiceSettings：
    //    点击后的首个进度回调要等节流窗口，progress undefined 时断裂轮询 = 永不显示）
    if (m.downloading) {
      if (progressRow) progressRow.hidden = false;
      const p = m.downloadProgress;
      const bar = $('#tts-progress-bar');
      if (bar) bar.style.width = (p?.stage === 'model' ? (p?.percent || 0) : 0) + '%';
      const text = $('#tts-progress-text');
      if (text) {
        text.textContent = !p
          ? '准备中…'
          : (p.stage === 'deps'
            ? `依赖安装：${p.file}`
            : `${p.file} · ${p.percent}% · ${((p.received || 0) / 1048576).toFixed(1)}/${((p.total || 0) / 1048576).toFixed(1)} MB · ${p.speed || ''}`);
      }
      setTimeout(() => { if (currentView() === 'settings') loadTtsSettings(); }, 800);
    } else if (progressRow) {
      progressRow.hidden = true;
      if (st.downloadError) {
        if (progressRow) progressRow.hidden = false;
        const text = $('#tts-progress-text');
        if (text) text.textContent = '上次错误：' + st.downloadError;
      }
    }
    // python 环境（无缓存时显示未检测，不自动探测 —— 探测要起子进程）
    const py = st.python;
    const pyDesc = $('#tts-python-desc');
    if (pyDesc) {
      pyDesc.textContent = py
        ? (py.pythonAvailable
          ? `python ${py.pythonVersion || ''} · cosyvoice 包：${py.cosyvoiceInstalled === true ? '已安装' : py.cosyvoiceInstalled === false ? '未安装（点上方「下载」自动配置依赖）' : '未检测'}`
          : `未检测到 python —— ${py.hint}`)
        : '未检测（点「检测」）';
    }
    const pathInput = $('#tts-python-path');
    if (pathInput && py && py.pythonPath && py.pythonPath !== 'python' && document.activeElement !== pathInput) {
      pathInput.value = py.pythonPath;
    }
    // 服务状态 —— 按**当前引擎**分流，别照搬 cosyvoice 视角
    //   tts.status 返回的 service/model 都是 CosyVoice 的。切到 breeze 后那个
    //   「未运行」说的是 CosyVoice 服务，与当前引擎能否出声无关；照它显示会把
    //   「breeze 就绪可用」误报成不可用。引擎信息由上面 tts.engines 分支写进 dataset，
    //   拿不到（请求失败）就退回 cosyvoice 视角 —— 默认引擎就是 cosyvoice3。
    const svc = st.service || {};
    const engineKind = stateEl.dataset.engineKind || '';
    const engineReady = stateEl.dataset.engineReady === '1';
    const isCosy = engineKind === '' || engineKind === 'cosyvoice3';
    stateEl.textContent = isCosy
      ? (svc.running ? '运行中' : '未运行')
      : (engineReady ? '就绪' : '未就绪');
    const svcDesc = $('#tts-service-desc');
    if (svcDesc) {
      svcDesc.textContent = svc.running
        ? `运行中（127.0.0.1:${svc.port}）`
        : `未运行${svc.lastError ? ' —— 上次错误：' + svc.lastError : ' —— 启动含模型加载，可能需要 1~2 分钟'}`;
    }
    const startBtn = $('#tts-start-btn');
    if (startBtn) startBtn.disabled = !m.ready || !!svc.running;
    const stopBtn = $('#tts-stop-btn');
    if (stopBtn) stopBtn.disabled = !svc.running;
    // 试听走 synthesizeViaEngine（任何引擎都成立）⇒ 只按**引擎就绪度**禁用。
    //   cosyvoice 例外：它的 synthesize 直接打本地 3178 服务，服务没起就一定失败，
    //   所以那一路额外要求 svc.running。
    const testBtn = $('#tts-test-btn');
    if (testBtn) testBtn.disabled = isCosy ? !svc.running : !engineReady;
  }

  // ── 插件贡献卡（UI 插件化，2026-10-24）──────────────────────────
  // 插件声明 uiCards（kind=渲染器键，slot=挂载槽位），webui 持有渲染器注册表：
  // 插件决定「出现什么/挂哪里/何时消失」（卸载即无此卡），渲染器本体留在前端
  // —— 插件不注入任意 HTML。卡片 DOM 每次进 tab 重建（data-plugin-card 标记
  // 先行移除，幂等），事件绑定随新 DOM 重新执行。

  /** say-voice-broadcast：say 交付的语音播报开关 + 默认音色 */
  function buildSayBroadcastCard() {
    const card = el('div', 'settings-card');
    card.innerHTML =
      '<div class="settings-card-header"><i data-lucide="volume-2" class="w-4 h-4"></i><span>say 语音播报</span></div>' +
      '<div class="settings-row">' +
      '  <div>' +
      '    <div class="settings-label">播报交付内容</div>' +
      '    <div class="settings-desc">开启后，say 工具交付的结论自动朗读（模型在模型未就绪时会播报失败并提示）。LLM 可在 say 里用 voice/speed/broadcast 参数逐次覆盖</div>' +
      '  </div>' +
      '  <input type="checkbox" id="say-broadcast-toggle" class="settings-toggle" aria-label="启用 say 语音播报" />' +
      '</div>' +
      '<div class="settings-row">' +
      '  <div style="min-width:0">' +
      '    <div class="settings-label">默认音色</div>' +
      '    <div class="settings-desc">音色 = 参考音对（同名 &lt;音色&gt;.wav + &lt;音色&gt;.txt，放 &lt;音色&gt;.wav 与逐字文字稿），放入该目录即出现在此列表；default 为默认音色</div>' +
      '    <div class="settings-desc" id="say-voices-dir" data-dom-id="say-voices-dir" style="opacity:0.7;word-break:break-all;margin-top:4px">—</div>' +
      '  </div>' +
      '  <select id="say-broadcast-voice" class="settings-input" aria-label="默认音色"></select>' +
      '</div>';
    return card;
  }

  function bindSayBroadcastCard() {
    const toggle = $('#say-broadcast-toggle');
    if (toggle) toggle.addEventListener('change', async () => {
      try {
        await client.request('tts.setSayBroadcast', { broadcast: toggle.checked });
      } catch (e) {
        appendMsg('error', '保存播报开关失败：' + ((e && e.message) || e));
        toggle.checked = !toggle.checked;
      }
    });
    const voiceSel = $('#say-broadcast-voice');
    if (voiceSel) voiceSel.addEventListener('change', async () => {
      try {
        await client.request('tts.setSayBroadcast', { voice: voiceSel.value });
      } catch (e) {
        appendMsg('error', '保存默认音色失败：' + ((e && e.message) || e));
      }
    });
  }

  async function loadSayBroadcastCard() {
    const toggle = $('#say-broadcast-toggle');
    const voiceSel = $('#say-broadcast-voice');
    if (!toggle && !voiceSel) return;
    let st = null;
    try { st = await client.request('tts.status'); } catch (e) { st = null; }
    if (!st) return;
    const say = st.say || {};
    const dirEl = $('#say-voices-dir');
    if (dirEl && st.voicesDir) dirEl.textContent = '参考音目录：' + st.voicesDir;
    if (toggle) toggle.checked = say.broadcast === true;
    if (voiceSel) {
      const voices = Array.isArray(st.voices) ? st.voices : [];
      const cur = say.voice || '';
      voiceSel.innerHTML = '';
      for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.label || v.id;
        if (v.id === cur) opt.selected = true;
        voiceSel.appendChild(opt);
      }
      if (!voices.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'default';
        voiceSel.appendChild(opt);
      }
    }
  }

  /** say-voice-tts：TTS 引擎管理（模型下载/python 环境/推理服务启停/试听）—— 原设置页硬编码卡迁入 */
  function buildTtsCard() {
    const card = el('div', 'settings-card');
    card.innerHTML =
      '<div class="settings-card-header"><i data-lucide="speech" class="w-4 h-4"></i><span>语音合成</span><span id="tts-service-state" data-dom-id="tts-service-state" class="settings-desc" style="margin-left:auto">未运行</span></div>' +
      // 引擎选择：say 工具实际接到哪个 TTS 实现（voice.tts.engine）。
      // 切换后写配置即生效，下一回合 say 用新引擎，不需要重启。
      '<div class="settings-row">' +
      '  <div style="min-width:0">' +
      '    <div class="settings-label">引擎（say 接在哪个）</div>' +
      '    <div class="settings-desc" id="tts-engine-desc" data-dom-id="tts-engine-desc">—</div>' +
      '  </div>' +
      '  <select id="tts-engine" class="settings-input" data-dom-id="tts-engine" aria-label="TTS 引擎"></select>' +
      '</div>' +
      // ── 在线引擎配置（voice.tts.online.*）──────────────────────────
      // 只在选中「在线 API」时显示。没有这块，用户选了在线引擎却无处填 key，
      // 会永远停在「未就绪（缺 apiKey）」—— 等于给了个选不了的选项。
      // 密钥框**不回填明文**：后端只回 hasApiKey / apiKeySource，留空 = 不修改，
      // 这样 DOM 属性、截图、前端调试面板里永远不会出现密钥。
      '<div id="tts-online-block" data-dom-id="tts-online-block" hidden>' +
      '  <div class="settings-row">' +
      '    <div class="settings-label">在线引擎配置</div>' +
      '    <div class="settings-desc" id="tts-online-key-state" data-dom-id="tts-online-key-state" style="margin-left:auto">—</div>' +
      '  </div>' +
      '  <div class="settings-row"><div class="settings-label">厂家</div>' +
      '    <select id="tts-online-provider" class="settings-input" data-dom-id="tts-online-provider" aria-label="在线引擎厂家" style="flex:0 0 260px">' +
      '      <option value="breeze">breeze（xi-api-key 认证）</option>' +
      '      <option value="openai-compatible">OpenAI 兼容（Bearer 认证）</option>' +
      '    </select></div>' +
      '  <div class="settings-row"><div class="settings-label">API key</div>' +
      '    <div style="display:flex;gap:8px;flex:0 0 260px">' +
      '      <input id="tts-online-apikey" class="settings-input" data-dom-id="tts-online-apikey" type="password" autocomplete="off" placeholder="留空 = 不修改" style="flex:1 1 auto;min-width:0" />' +
      '      <button id="tts-online-apikey-clear" data-dom-id="tts-online-apikey-clear" style="cursor:pointer;font-family:inherit;flex:0 0 auto;display:none" title="删除 config.json 里已保存的密钥">清除</button>' +
      '    </div></div>' +
      '  <div class="settings-row"><div class="settings-label">Base URL</div>' +
      '    <input id="tts-online-baseurl" class="settings-input" data-dom-id="tts-online-baseurl" placeholder="https://api.breeze.blue" style="flex:0 0 260px" /></div>' +
      '  <div class="settings-row"><div class="settings-label">模型</div>' +
      '    <input id="tts-online-model" class="settings-input" data-dom-id="tts-online-model" placeholder="breeze-tts-2" style="flex:0 0 260px" /></div>' +
      '  <div class="settings-row"><div class="settings-label">音色 id</div>' +
      '    <input id="tts-online-voice" class="settings-input" data-dom-id="tts-online-voice" placeholder="空 = 厂家默认" style="flex:0 0 260px" /></div>' +
      '  <div class="settings-row"><div class="settings-label">语言 / 输出格式</div>' +
      '    <div style="display:flex;gap:8px;flex:0 0 260px">' +
      '      <input id="tts-online-language" class="settings-input" data-dom-id="tts-online-language" placeholder="zh" style="flex:1 1 auto;min-width:0" />' +
      '      <input id="tts-online-format" class="settings-input" data-dom-id="tts-online-format" placeholder="wav_24000" style="flex:1 1 auto;min-width:0" />' +
      '    </div></div>' +
      '  <div class="settings-row"><div class="settings-label">超时（毫秒）</div>' +
      '    <input id="tts-online-timeout" class="settings-input" data-dom-id="tts-online-timeout" type="number" min="1000" step="1000" placeholder="60000" style="flex:0 0 260px" /></div>' +
      '  <div class="settings-row"><div></div>' +
      '    <button id="tts-online-save" class="settings-input" data-dom-id="tts-online-save" style="cursor:pointer;font-family:inherit;flex:0 0 auto">保存</button></div>' +
      '</div>' +
      // ── breeze-tts-2 本地引擎配置（voice.tts.breeze.*）──────────────
      // 只在选中 breeze-tts-2 时显示。这三项此前**只能手改 config.json**
      // （UI 层 grep cliPath/modelPath 零命中）⇒ 装了引擎却没法在界面里配。
      // 路径存在性由后端 stat，绿/红灯当场区分「填了」和「能用」。
      '<div id="tts-breeze-block" data-dom-id="tts-breeze-block" hidden>' +
      '  <div class="settings-row">' +
      '    <div style="min-width:0">' +
      '      <div class="settings-label">本地 BreezeTTS2</div>' +
      '      <div class="settings-desc" id="tts-breeze-desc" data-dom-id="tts-breeze-desc">—</div>' +
      '    </div>' +
      '    <div style="display:flex;gap:8px;flex:0 0 auto">' +
      '      <button id="tts-breeze-start-btn" class="settings-input" data-dom-id="tts-breeze-start-btn" style="cursor:pointer;font-family:inherit">启动常驻服务</button>' +
      '      <button id="tts-breeze-stop-btn" class="settings-input" data-dom-id="tts-breeze-stop-btn" style="cursor:pointer;font-family:inherit">停止</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="settings-row"><div class="settings-label">CLI 路径</div>' +
      '    <div style="display:flex;gap:8px;flex:0 0 340px">' +
      '      <input id="tts-breeze-clipath" class="settings-input" data-dom-id="tts-breeze-clipath" placeholder="C:\\TTSEngines\\audio-cpp\\audiocpp_cli.exe" style="flex:1 1 auto;min-width:0" />' +
      '      <span id="tts-breeze-cli-flag" data-dom-id="tts-breeze-cli-flag" class="settings-desc" style="flex:0 0 auto">—</span>' +
      '    </div></div>' +
      '  <div class="settings-row"><div class="settings-label">GGUF 模型路径</div>' +
      '    <div style="display:flex;gap:8px;flex:0 0 340px">' +
      '      <input id="tts-breeze-modelpath" class="settings-input" data-dom-id="tts-breeze-modelpath" placeholder="C:\\TTSEngines\\dl\\breeze-tts-2-q8_0.gguf" style="flex:1 1 auto;min-width:0" />' +
      '      <span id="tts-breeze-model-flag" data-dom-id="tts-breeze-model-flag" class="settings-desc" style="flex:0 0 auto">—</span>' +
      '    </div></div>' +
      '  <div class="settings-row"><div class="settings-label">后端 / 设备 / 端口</div>' +
      '    <div style="display:flex;gap:8px;flex:0 0 340px">' +
      '      <select id="tts-breeze-backend" class="settings-input" data-dom-id="tts-breeze-backend" style="flex:0 0 100px">' +
      '        <option value="cuda">cuda</option><option value="cpu">cpu</option><option value="vulkan">vulkan</option>' +
      '      </select>' +
      '      <input id="tts-breeze-device" class="settings-input" data-dom-id="tts-breeze-device" type="number" min="0" placeholder="0" style="flex:0 0 70px" />' +
      '      <input id="tts-breeze-port" class="settings-input" data-dom-id="tts-breeze-port" type="number" min="1" max="65535" placeholder="8189" style="flex:0 0 90px" />' +
      '    </div></div>' +
      '  <div class="settings-row"><div class="settings-label">自动起常驻服务</div>' +
      '    <label style="display:flex;align-items:center;gap:6px;flex:0 0 auto">' +
      '      <input id="tts-breeze-autostart" data-dom-id="tts-breeze-autostart" type="checkbox" />' +
      '      <span class="settings-desc">首次 say 时自动拉起（单次 9s → 2s）</span>' +
      '    </label></div>' +
      '  <div class="settings-row"><div></div>' +
      '    <button id="tts-breeze-save" class="settings-input" data-dom-id="tts-breeze-save" style="cursor:pointer;font-family:inherit;flex:0 0 auto">保存</button></div>' +
      '</div>' +
      // ── CosyVoice3 专属区（模型权重 / python 依赖 / 推理服务）──────────
      // 只在选中 cosyvoice3 时显示。切到 breeze 后这些控件全都失去意义，
      // 其中「下载」最危险：它走 tts.download → cosyvoice 单例，点了会拉
      // 3.7GB 的 CosyVoice3 权重，而界面上没有任何提示 —— 用户会以为是在给
      // 当前引擎（breeze）下模型。
      // 试听**不**放进来：它走 synthesizeViaEngine，对哪个引擎都有效。
      '<div id="tts-cosyvoice-block" data-dom-id="tts-cosyvoice-block" hidden>' +
      '<div class="settings-row">' +
      '  <div style="min-width:0">' +
      '    <div class="settings-label">模型版本</div>' +
      '    <div class="settings-desc">base 与 rl 只差一个 LLM 权重（共用其余约 2.6GB，增量下载）；rl 为强化学习对齐版，效果更自然</div>' +
      '  </div>' +
      '  <select id="tts-variant" class="settings-input" data-dom-id="tts-variant" aria-label="模型版本">' +
      '    <option value="rl">rl（推荐）</option>' +
      '    <option value="base">base</option>' +
      '  </select>' +
      '</div>' +
      '<div class="settings-row">' +
      '  <div style="min-width:0">' +
      '    <div class="settings-label">模型文件</div>' +
      '    <div class="settings-desc" id="tts-model-desc" data-dom-id="tts-model-desc">—</div>' +
      '  </div>' +
      '  <button id="tts-model-download" class="settings-input" data-dom-id="tts-model-download" style="cursor:pointer;font-family:inherit;flex:0 0 auto">下载 CosyVoice3 模型</button>' +
      '</div>' +
      '<div class="settings-row" id="tts-progress-row" hidden>' +
      '  <div style="flex:1 1 auto">' +
      '    <div style="height:6px;border-radius:3px;background:var(--hyacinth-muted);overflow:hidden">' +
      '      <div id="tts-progress-bar" style="height:100%;width:0%;background:var(--hyacinth-primary);transition:width 300ms ease"></div>' +
      '    </div>' +
      '    <div class="settings-desc" id="tts-progress-text" style="margin-top:4px">—</div>' +
      '  </div>' +
      '</div>' +
      '<div class="settings-row">' +
      '  <div style="min-width:0">' +
      '    <div class="settings-label">python 环境（外来环境，按需安装）</div>' +
      '    <div class="settings-desc" id="tts-python-desc" data-dom-id="tts-python-desc">未检测 —— 需要 python 3.10+ 与 torch；cosyvoice 依赖点「下载」自动配置</div>' +
      '    <div style="display:flex;gap:8px;margin-top:6px">' +
      '      <input id="tts-python-path" class="settings-input" data-dom-id="tts-python-path" placeholder="python 路径（如 C:\\Python310\\python.exe，留空用 PATH）" style="flex:1 1 auto;min-width:0" />' +
      '      <button id="tts-python-detect" class="settings-input" data-dom-id="tts-python-detect" style="cursor:pointer;font-family:inherit;flex:0 0 auto">检测</button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="settings-row">' +
      '  <div>' +
      '    <div class="settings-label">推理服务（127.0.0.1，仅本机）</div>' +
      '    <div class="settings-desc" id="tts-service-desc" data-dom-id="tts-service-desc">未运行 —— 冷启动含模型加载，可能需要 1~2 分钟</div>' +
      '  </div>' +
      '  <div style="display:flex;gap:8px;flex:0 0 auto">' +
      '    <button id="tts-start-btn" class="settings-input" data-dom-id="tts-start-btn" style="cursor:pointer;font-family:inherit">启动</button>' +
      '    <button id="tts-stop-btn" class="settings-input" data-dom-id="tts-stop-btn" style="cursor:pointer;font-family:inherit">停止</button>' +
      '  </div>' +
      '</div>' +
      '</div>' +
      // 试听：走当前选中引擎（synthesizeViaEngine），因此对任何引擎都成立，
      // 不放进上面那个 cosyvoice 专属区。
      '<div class="settings-row">' +
      '  <div style="min-width:0">' +
      '    <div class="settings-label">试听</div>' +
      '    <div class="settings-desc">用当前选中的引擎合成一句话并播放，验证播报链路</div>' +
      '  </div>' +
      '  <button id="tts-test-btn" class="settings-input" data-dom-id="tts-test-btn" style="cursor:pointer;font-family:inherit;flex:0 0 auto">试听</button>' +
      '</div>';
    return card;
  }

  function bindTtsCard() {
    // 引擎切换（「say 接在哪个」）：写 voice.tts.engine ⇒ 下一回合 say 换过去。
    // 不重启进程：TTS 工厂按"配置指纹"重建实例（见 src/tts/index.ts 的 engineKey）。
    const engSel = $('#tts-engine');
    if (engSel) engSel.addEventListener('change', async () => {
      try {
        await client.request('tts.setEngine', { kind: engSel.value });
      } catch (e) {
        appendMsg('error', '切换 TTS 引擎失败：' + ((e && e.message) || e));
      }
      void loadTtsSettings();
    });
    // 在线引擎配置保存：只发**用户真正填了**的字段。
    // 密钥框留空 = 不修改（后端从不回填明文，所以空值绝不能当成"清空密钥"发出去，
    // 否则用户切一次 provider 就把密钥抹了）。
    const onlineSave = $('#tts-online-save');
    if (onlineSave) onlineSave.addEventListener('click', async () => {
      onlineSave.disabled = true;
      const val = (sel) => ($(sel)?.value ?? '').trim();
      const patch = {
        provider: val('#tts-online-provider') || undefined,
        baseUrl: val('#tts-online-baseurl'),
        model: val('#tts-online-model'),
        voice: val('#tts-online-voice'),
        language: val('#tts-online-language'),
        format: val('#tts-online-format'),
      };
      const key = val('#tts-online-apikey');
      if (key) patch.apiKey = key; // 空 = 不改（见上）
      const t = val('#tts-online-timeout');
      if (t) patch.timeoutMs = Number(t);
      try {
        await client.request('tts.setOnlineConfig', patch);
      } catch (e) {
        appendMsg('error', '保存在线引擎配置失败：' + ((e && e.message) || e));
      }
      onlineSave.disabled = false;
      void loadTtsSettings();
    });
    // 「清除密钥」：显式传空串把 config.json 里的密钥删掉。
    // 为什么必须单独一个按钮：保存按钮把空值当"不修改"（否则用户切一次 provider
    // 就会把密钥抹了），于是设错了 key 就再也没有出路 —— 这是死路，必须留显式出口。
    const keyClear = $('#tts-online-apikey-clear');
    if (keyClear) keyClear.addEventListener('click', async () => {
      keyClear.disabled = true;
      try {
        // apiKey: '' 是"清除"语义，与保存按钮的空值跳过是两条不同的约定
        await client.request('tts.setOnlineConfig', { apiKey: '' });
      } catch (e) {
        appendMsg('error', '清除密钥失败：' + ((e && e.message) || e));
      }
      keyClear.disabled = false;
      void loadTtsSettings();
    });
    // 换厂家 ⇒ 默认端点/格式跟着变，提示一下（不自动改写用户已填的值）
    const providerSel = $('#tts-online-provider');
    if (providerSel) providerSel.addEventListener('change', () => {
      const hint = $('#tts-online-key-state');
      if (!hint) return;
      const cur = providerSel.value;
      hint.textContent = cur === 'breeze'
        ? 'breeze：认证头 xi-api-key，格式建议 wav_24000'
        : 'OpenAI 兼容：认证头 Bearer，格式建议 wav / mp3';
    });
    const download = $('#tts-model-download');
    if (download) download.addEventListener('click', async () => {
      download.disabled = true;
      const variant = $('#tts-variant')?.value || 'rl';
      try { await client.request('tts.download', { variant }); } catch (e) {
        appendMsg('error', '触发模型下载失败：' + ((e && e.message) || e));
      }
      void loadTtsSettings();
    });
    const variantSel = $('#tts-variant');
    if (variantSel) variantSel.addEventListener('change', () => { void loadTtsSettings(); });
    const detect = $('#tts-python-detect');
    if (detect) detect.addEventListener('click', async () => {
      detect.disabled = true;
      const pyDesc = $('#tts-python-desc');
      if (pyDesc) pyDesc.textContent = '检测中…';
      const pathInput = $('#tts-python-path');
      const p = pathInput && pathInput.value.trim();
      try {
        if (p) await client.request('tts.setPythonPath', { pythonPath: p });
        await client.request('tts.detectPython');
      } catch (e) {
        if (pyDesc) pyDesc.textContent = '检测失败：' + ((e && e.message) || e);
      }
      detect.disabled = false;
      void loadTtsSettings();
    });
    const start = $('#tts-start-btn');
    if (start) start.addEventListener('click', async () => {
      start.disabled = true;
      const svcDesc = $('#tts-service-desc');
      if (svcDesc) svcDesc.textContent = '启动中…（含模型加载）';
      try { await client.request('tts.start'); } catch (e) {
        appendMsg('error', 'TTS 服务启动失败：' + ((e && e.message) || e));
      }
      void loadTtsSettings();
    });
    const stop = $('#tts-stop-btn');
    if (stop) stop.addEventListener('click', async () => {
      try { await client.request('tts.stop'); } catch (e) { /* ignore */ }
      void loadTtsSettings();
    });
    const test = $('#tts-test-btn');
    if (test) test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        // broadcast=true：后端广播 tts.say_voice 事件 → handleSayVoice 播放 ——
        // 与 say 工具播报同一条通路（试听即播报链验证，不做前端本地播放）
        await client.request('tts.synthesize', {
          text: '你好，我是风信子，很高兴为你朗读这段话。',
          broadcast: true,
        });
      } catch (e) {
        appendMsg('error', '试听合成失败：' + ((e && e.message) || e));
      }
      test.disabled = false;
    });
    // ── breeze 本地引擎配置（第一档：路径/端口在 UI 里配）────────────
    // 保存只写配置不重启服务：改完路径要不要拉起是用户的决定
    // （他可能只是想先填好、下次再启动）。生效时机由下面两个按钮显式触发。
    const bSave = $('#tts-breeze-save');
    if (bSave) bSave.addEventListener('click', async () => {
      bSave.disabled = true;
      const val = (sel) => ($(sel)?.value ?? '').trim();
      const patch = {
        cliPath: val('#tts-breeze-clipath'),
        modelPath: val('#tts-breeze-modelpath'),
        backend: val('#tts-breeze-backend') || undefined,
        serverAutoStart: !!$('#tts-breeze-autostart')?.checked,
      };
      const dev = val('#tts-breeze-device');
      if (dev !== '') patch.device = Number(dev);
      const port = val('#tts-breeze-port');
      if (port !== '') patch.serverPort = Number(port);
      try {
        await client.request('tts.setBreezeConfig', patch);
      } catch (e) {
        appendMsg('error', '保存 breeze 配置失败：' + ((e && e.message) || e));
      }
      bSave.disabled = false;
      void loadTtsSettings();
    });
    const bStart = $('#tts-breeze-start-btn');
    if (bStart) bStart.addEventListener('click', async () => {
      bStart.disabled = true;
      const d = $('#tts-breeze-desc');
      if (d) d.textContent = '启动中…（加载 GGUF 到显存，可能需要数十秒）';
      try {
        await client.request('tts.breezeStart');
      } catch (e) {
        appendMsg('error', 'breeze 常驻服务启动失败：' + ((e && e.message) || e));
      }
      bStart.disabled = false;
      void loadTtsSettings();
    });
    const bStop = $('#tts-breeze-stop-btn');
    if (bStop) bStop.addEventListener('click', async () => {
      try { await client.request('tts.breezeStop'); } catch (e) { /* ignore */ }
      void loadTtsSettings();
    });
  }

  /** 渲染器注册表：kind → 构建器 + 绑定器 + 数据加载器（新插件卡在此登记渲染器） */
  const pluginCardRenderers = {
    'say-voice-broadcast': { build: buildSayBroadcastCard, bind: bindSayBroadcastCard, load: loadSayBroadcastCard },
    'say-voice-tts': { build: buildTtsCard, bind: bindTtsCard, load: loadTtsSettings },
  };

  /**
   * 挂载插件贡献卡到指定槽位（进 tab 时调用，幂等：先移除旧卡再重建）。
   * 槽位 → 容器：settings.voice = #panel-voice（语音 tab 面板）。
   */
  async function mountPluginCards(slot) {
    const panel = slot === 'settings.voice' ? $('#panel-voice') : null;
    if (!panel) return;
    let plugins = null;
    try { plugins = await client.request('plugin.list'); } catch (e) { plugins = null; }
    panel.querySelectorAll('[data-plugin-card]').forEach((n) => n.remove());
    if (!Array.isArray(plugins)) return;
    const cards = [];
    for (const p of plugins) {
      if (!p || p.state !== 'mounted' || !Array.isArray(p.uiCards)) continue;
      for (const c of p.uiCards) {
        if (c && c.slot === slot && pluginCardRenderers[c.kind]) cards.push({ ...c, pluginId: p.id });
      }
    }
    cards.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    for (const c of cards) {
      const node = pluginCardRenderers[c.kind].build();
      node.setAttribute('data-plugin-card', c.pluginId + ':' + c.kind);
      panel.appendChild(node);
    }
    for (const c of cards) {
      try { pluginCardRenderers[c.kind].bind(); } catch (e) { /* 绑定失败不阻断其它卡 */ }
    }
    if (cards.length) {
      if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
      for (const c of cards) {
        try { void pluginCardRenderers[c.kind].load(); } catch (e) { /* ignore */ }
      }
    }
  }

  function bindModelPicker() {
    const btn = $('#model-pick-btn');
    const pop = $('#model-pop');
    if (!btn || !pop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelPickOpen(pop.hidden);
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (!pop.hidden) modelPickOpen(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) {
        e.stopPropagation();
        modelPickOpen(false);
      }
    });
    // 视口变化（窗口缩放 / 预览栏拖宽）时重定位 —— 弹层锚定的是按钮 rect
    window.addEventListener('resize', () => { if (!pop.hidden) positionModelPop(); });
    void modelPickLoad();
  }

  // ── 根目录切换 ────────────────────────────────────────────────
  // 预览栏原本锁死在启动目录，想看桌面上的产物只能绕出去。
  // 这里给一个目录选择器：浏览用 preview.browse（只回目录名、只限本机），
  // 落定用 preview.setRoot。选中的根由**服务端**持久化（~/.agent/preview-root.json），
  // 所以重启后还在，多个标签页也不会各看各的。

  /** 面板里最多露几个盘符 chip（多于此数的走路径输入框） */
  const PV_MAX_DRIVE_CHIPS = 4;

  /** 选择器自己的临时状态，与 pv 分开：关掉面板不该影响正在看的那棵树 */
  const pvRoot = {
    open: false,
    dir: '',          // 正在浏览的目录（绝对路径）
    parent: '',       // 上一级（盘符根时为空）
    entries: [],
    shortcuts: [],
    recent: [],
    loading: false,
  };

  function pvRootEls() {
    return {
      pop: $('#pv-root-pop'),
      btn: $('#pv-root-btn'),
      chips: $('#pv-root-shortcuts'),
      path: $('#pv-root-path'),
      up: $('#pv-root-up'),
      list: $('#pv-root-list'),
      note: $('#pv-root-note'),
      open: $('#pv-root-open'),
      cancel: $('#pv-root-cancel'),
    };
  }

  /** Windows 下路径比较要不分大小写（'C:\\Foo' 与 'c:\\foo' 是同一处） */
  function pvSamePath(a, b) {
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
  }

  function pvApplyRootMeta(m) {
    if (!m) return;
    pv.rootName = m.name || m.root || '根目录';
    pv.rootAbs = m.root || '';
    pv.rootDefault = m.defaultRoot || pv.rootDefault || '';
    pv.isCustomRoot = !!m.isCustom;
    const name = $('#pv-root-name');
    if (name) name.textContent = pv.rootName;
    const btn = $('#pv-root-btn');
    if (btn) {
      btn.title = (m.root || '')
        + (pv.isCustomRoot && pv.rootDefault ? '\n工作区：' + pv.rootDefault : '')
        + '\n点击切换根目录';
      btn.classList.toggle('is-custom', pv.isCustomRoot);
    }
  }

  function pvRootOpen(on) {
    const { pop, btn, path } = pvRootEls();
    if (!pop || !btn) return;
    const next = !!on && pv.open;
    pop.hidden = !next;
    pvRoot.open = next;
    btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (!next) return;
    // 每次打开都从"当前根"重新起步：上次浏览到别处去，不该留着当起点
    if (path) path.value = pv.rootAbs;
    void pvRootBrowse(pv.rootAbs || '');
  }

  async function pvRootBrowse(dir) {
    const { list, path, note, open } = pvRootEls();
    if (!list) return;
    // 连点目录时只认最后一次：慢响应先回来会把新目录盖掉
    if (pvRoot.loading) return;
    pvRoot.loading = true;
    list.textContent = '';
    list.appendChild(el('div', 'pv-root-note-inline', '读取中…'));
    try {
      const d = await pvRpc('browse', dir ? { dir } : {});
      pvRoot.dir = d.dir || '';
      pvRoot.parent = d.parent || '';
      pvRoot.entries = d.entries || [];
      pvRoot.shortcuts = d.shortcuts || [];
      pvRoot.recent = d.recent || [];
      if (path) path.value = pvRoot.dir;
      if (note) note.textContent = '不影响 agent 的工作目录';
      if (open) open.disabled = false;
      pvRootRender();
    } catch (e) {
      list.textContent = '';
      list.appendChild(el('div', 'pv-root-note-inline is-error',
        (e && e.message) || '读取目录失败'));
      if (note) note.textContent = '';
      if (open) open.disabled = true;
    } finally {
      pvRoot.loading = false;
    }
  }

  function pvRootRender() {
    const { chips, list, up } = pvRootEls();
    if (!list || !chips) return;

    // 快捷位置：工作区 / 主目录 / 盘符 / 最近用过的
    chips.textContent = '';
    let driveShown = 0;
    const mkChip = (label, dir, extraCls) => {
      const b = el('button', 'pv-root-chip' + (extraCls ? ' ' + extraCls : ''), label);
      b.type = 'button';
      b.title = dir;
      b.onclick = () => void pvRootBrowse(dir);
      chips.appendChild(b);
    };
    for (const s of pvRoot.shortcuts) {
      // 盘符最多露 4 个：这台机器有 9 个（C:–J:），全铺出来会把面板挤成
      // 两行 chip，还把"最近用过"顶到看不见的地方。要别的盘直接改路径框。
      if (s.kind === 'drive') {
        driveShown += 1;
        if (driveShown > PV_MAX_DRIVE_CHIPS) continue;
      }
      const cls = [];
      if (pvSamePath(s.path, pvRoot.dir)) cls.push('is-current');
      if (s.kind === 'workspace') cls.push('is-dir');
      mkChip(s.label, s.path, cls.join(' '));
    }
    for (const r of pvRoot.recent.slice(0, 3)) {
      if (pvRoot.shortcuts.some((s) => pvSamePath(s.path, r))) continue;
      mkChip(pathBaseName(r) || r, r, 'is-dir' + (pvSamePath(r, pvRoot.dir) ? ' is-current' : ''));
    }

    // 上级：盘符根没有 parent，此时按钮禁用而不是隐藏（位置不跳动）
    if (up) up.disabled = !pvRoot.parent;

    list.textContent = '';
    if (!pvRoot.entries.length) {
      list.appendChild(el('div', 'pv-root-note-inline', '这个目录下没有子目录，可以直接「在此打开」'));
      return;
    }
    for (const e of pvRoot.entries) {
      const row = el('div', 'pv-root-item');
      row.setAttribute('role', 'option');
      row.tabIndex = 0;
      row.title = e.path;
      row.appendChild(pvIcon('folder'));
      row.appendChild(el('span', 'pv-root-item-name', e.name));
      const go = () => void pvRootBrowse(e.path);
      row.onclick = go;
      row.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
      };
      list.appendChild(row);
    }
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* 图标缺失不影响功能 */ } }
  }

  /** 取路径最后一段（盘符根返回自身，避免出现空标签） */
  function pathBaseName(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /**
   * 多标签页同步：预览根是**服务端**状态，但服务端没有"根变了"的广播通道
   * （fs 面刻意只做 REST，不为一个视图状态加事件流）。于是用 BroadcastChannel
   * 在**同源标签页之间**补一条旁路：A 页换了根 → B 页收到 → 重新拉 meta 并重画。
   *
   * 为什么不在收到消息时直接信消息里的 root：服务端才是真源（也可能是**失败**的切换、
   * 或第三人改了最近记录）。所以消息只当"提醒"，内容一律重新问服务端要。
   * 特性检测兜底：老浏览器没有 BroadcastChannel 时退化成"开栏时自然对齐"。
   */
  const PV_CH_NAME = 'hyacinth.preview-root';
  let pvChannel = null;
  function pvChannelInit() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      pvChannel = new BroadcastChannel(PV_CH_NAME);
    } catch (e) { return; }
    pvChannel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg || msg.type !== 'root-changed') return;
      // 自己发的不会回到自己（BroadcastChannel 不回声），这里再稳一手：
      // 若本地根已经是那个值，说明差异不存在，直接返回，省一次 IO
      if (msg.root && pvSamePath(msg.root, pv.rootAbs)) return;
      void pvAdoptServerRoot();
    };
  }

  /** 关栏时释放（页面 unload 也会自动释放，这里只是让显式关闭更干净） */
  function pvChannelClose() {
    if (!pvChannel) return;
    try { pvChannel.close(); } catch (e) { /* ignore */ }
    pvChannel = null;
  }

  /**
   * 跟随服务端当前的根：重拉 meta → 若确实变了，作废树与当前文件并重画。
   * 与 pvRootSwitch 的清理保持一致（相对路径含义已变，缓存一律不能留）。
   */
  async function pvAdoptServerRoot() {
    try {
      const m = await pvRpc('meta');
      if (!m) return;
      const changed = !pvSamePath(m.root, pv.rootAbs);
      pvApplyRootMeta(m);
      if (!changed) return;
      pv.cwd = '.';
      pv.expanded.clear();
      pv.children.clear();
      pv.inflight.clear();
      pv.current = null;
      pvRenderCrumbs();
      pvRenderTree();
      pvClearView();
      if (pv.open) await pvLoadDir('.');
    } catch (e) { /* 同步失败不影响本地这件小事，下次开栏会自然对齐 */ }
  }

  async function pvRootSwitch(dir) {
    const { open, note } = pvRootEls();
    const target = dir || pvRoot.dir;
    if (!target) return;
    if (open) open.disabled = true;
    if (note) note.textContent = '切换中…';
    try {
      const m = await pvRpc('setRoot', { root: target });
      pvApplyRootMeta(m);

      // 换根后旧树/旧文件全部作废：相对路径的含义已经变了，
      // 留着会让"点一下树"读到另一个目录里的同名文件
      pv.cwd = '.';
      pv.expanded.clear();
      pv.children.clear();
      pv.inflight.clear();
      pv.current = null;
      pvRenderCrumbs();
      pvRenderTree();
      pvClearView();
      pvRootOpen(false);
      await pvLoadDir('.');
      // 通知其它标签页（只广播成功的那次；失败留在本地提示里）
      if (pvChannel) {
        try { pvChannel.postMessage({ type: 'root-changed', root: pv.rootAbs }); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      if (note) note.textContent = (e && e.message) || '切换失败';
      if (open) open.disabled = false;
    }
  }

  /** 清空正文区（换根 / 关栏时用；与 pvOpenFile 的中间态清理保持一致） */
  function pvClearView() {
    const content = $('#pv-content');
    const meta = $('#pv-meta');
    const empty = $('#pv-empty');
    if (content) { content.textContent = ''; content.hidden = true; }
    if (meta) { meta.textContent = ''; meta.hidden = true; }
    if (empty) empty.hidden = false;
  }

  function bindPreviewDock() {
    // 结构自愈（2026-10-28 修「文件查看器跑到左下」）：预览栏必须是 .body-area 的 flex 子项
    // （.body-area 是 flex-row，它应是最右列）。HTML 解析曾把 .body-area 提前闭合，令
    // #preview-dock 沦为 #app-shell（flex-column）的子项 ⇒ 掉到左下/底部。这里发现父节点
    // 不是 .body-area 就挪回末尾（幂等：正常结构下是 no-op）。
    const baEl = document.querySelector('.body-area');
    const dockEl0 = document.getElementById('preview-dock');
    if (baEl && dockEl0 && dockEl0.parentElement !== baEl) baEl.appendChild(dockEl0);
    pvLoadPrefs();
    const dock = $('#preview-dock');
    if (!dock) return;

    // 多标签页：别的页换了根，这里跟着对齐（无 BroadcastChannel 的老浏览器退化为开栏对齐）
    pvChannelInit();
    window.addEventListener('pagehide', pvChannelClose);

    dock.style.setProperty('--pv-w', pv.width + 'px');
    dock.style.setProperty('--pv-tree-h', pv.treeH + '%');
    dock.style.setProperty('--pv-tree-w', pv.treeW + 'px');
    dock.hidden = !pv.open;
    // 放大 / 全屏态要在 DOM 就绪后立刻补上（持久化过来的），否则会先闪一帧窄栏
    if (pv.max && pv.open) pvSetMax(true);
    if (pv.full && pv.open) pvSetFull(true);

    const btn = $('#preview-toggle-btn');
    if (btn) {
      btn.setAttribute('aria-pressed', pv.open ? 'true' : 'false');
      btn.onclick = () => pvSetOpen(!pv.open);
    }
    const closeBtn = $('#pv-close-btn');
    if (closeBtn) closeBtn.onclick = () => pvSetOpen(false);

    // 放大 / 还原：一个按钮，图标随状态换（见 index.html 里的两个 svg）
    const maxBtn = $('#pv-max-btn');
    if (maxBtn) maxBtn.onclick = () => pvSetMax(!pv.max);

    // 全屏 / 退出全屏：只在放大态露面（CSS 控制显隐），点了就把目录收掉
    const fullBtn = $('#pv-full-btn');
    if (fullBtn) fullBtn.onclick = () => pvSetFull(!pv.full);

    // Esc 逐级退：根目录面板 → 全屏 → 放大，一次只退一层，不顺手把整栏关掉
    // （用户多半是想回去看聊天内容，不是要关掉预览）。
    // 有对话框/浮层开着时不抢 Esc：那种场景 Esc 属于那一层。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.cmd-overlay:not([hidden]), #permission-dialog:not([hidden])')) return;
      if (e.target && e.target.closest && e.target.closest('.cmd-overlay')) return;
      // 面板最先退：它是这一层里最"临时"的东西
      if (pvRoot.open) { pvRootOpen(false); return; }
      if (!pv.max) return;
      if (pv.full) pvSetFull(false); else pvSetMax(false);
    });

    // ── 根目录选择器 ──────────────────────────────────────────
    const rootBtn = $('#pv-root-btn');
    if (rootBtn) rootBtn.onclick = () => pvRootOpen(!pvRoot.open);
    {
      const els = pvRootEls();
      if (els.cancel) els.cancel.onclick = () => pvRootOpen(false);
      if (els.open) els.open.onclick = () => void pvRootSwitch(pvRoot.dir);
      if (els.up) els.up.onclick = () => { if (pvRoot.parent) void pvRootBrowse(pvRoot.parent); };
      // 回车 → 跳到输入框里的绝对路径；表单提交避免页面刷新
      const form = $('#pv-root-pathbar');
      if (form) {
        form.onsubmit = (e) => {
          e.preventDefault();
          const v = (els.path && els.path.value || '').trim();
          if (v) void pvRootBrowse(v);
        };
      }
      // 点面板外收起。判"里面"必须用 composedPath 而不是 t.closest：
      // 点目录行会立刻重绘列表，等事件冒泡到 document 时被点的节点已经脱离
      // 文档，closest('#pv-root-pop') 会返回 null ⇒ 误判成"点了外面"并把面板关掉
      // （实测：点任意子目录，面板跟着消失）。composedPath 是事件派发时快照
      // 下来的原始链路，节点后来被移除也不影响。
      document.addEventListener('click', (e) => {
        if (!pvRoot.open) return;
        const pathArr = typeof e.composedPath === 'function' ? e.composedPath() : [];
        const inside = pathArr.some((n) => n && (n.id === 'pv-root-pop' || n.id === 'pv-root-btn'));
        if (!inside) pvRootOpen(false);
      });
    }

    const refreshBtn = $('#pv-refresh-btn');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        pv.children.clear();
        pvRenderTree();
        await pvLoadDir(pv.cwd, true);
      };
    }

    // 宽度：左边缘竖条。上限随窗口收窄，别把主区挤到不可用
    const rz = $('#pv-resizer');
    if (rz) {
      pvDrag(rz, (e) => {
        const rect = dock.getBoundingClientRect();
        pv.width = pvClamp(rect.right - e.clientX, 280, Math.min(760, window.innerWidth - 420));
        dock.style.setProperty('--pv-w', pv.width + 'px');
      });
      // 键盘可达（分隔条有 tabindex）：左右箭头以 24px 步进
      rz.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
        if (!step) return;
        e.preventDefault();
        pv.width = pvClamp(pv.width + step, 280, Math.min(760, window.innerWidth - 420));
        dock.style.setProperty('--pv-w', pv.width + 'px');
        pvSave();
      });
    }

    // 分隔条：竖排是横条（调树高），放大态横排是竖条（调目录列宽）。
    // 同一个 #pv-split、同一套拖拽，只是按 pv.max 换轴和换算方式。
    const sp = $('#pv-split');
    if (sp) {
      // 目录列宽的上下限：至少够显示缩进两层的长文件名，至多留 360px 给正文
      const treeWBounds = (total) => [
        200, Math.min(560, Math.max(200, total - 360)),
      ];
      pvDrag(sp, (e) => {
        const rect = dock.getBoundingClientRect();
        if (pv.max) {
          const [lo, hi] = treeWBounds(rect.width);
          pv.treeW = pvClamp(rect.right - e.clientX, lo, hi);
          dock.style.setProperty('--pv-tree-w', pv.treeW + 'px');
        } else {
          pv.treeH = pvClamp(((e.clientY - rect.top) / rect.height) * 100, 15, 85);
          dock.style.setProperty('--pv-tree-h', pv.treeH + '%');
        }
      });
      sp.addEventListener('keydown', (e) => {
        // 往左拖 = 目录变宽（目录在右，分隔条左移就是给它让地方）
        const step = pv.max
          ? (e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0)
          : (e.key === 'ArrowUp' ? -3 : e.key === 'ArrowDown' ? 3 : 0);
        if (!step) return;
        e.preventDefault();
        if (pv.max) {
          const [lo, hi] = treeWBounds(dock.getBoundingClientRect().width);
          pv.treeW = pvClamp(pv.treeW + step, lo, hi);
          dock.style.setProperty('--pv-tree-w', pv.treeW + 'px');
        } else {
          pv.treeH = pvClamp(pv.treeH + step, 15, 85);
          dock.style.setProperty('--pv-tree-h', pv.treeH + '%');
        }
        pvSave();
      });
    }

    // 根目录元信息：拿不到就整栏禁用并说明原因（例如 WS 还没连上 / 通道未装配）。
    // bindPreviewDock 早于 client 创建执行，启动期 RPC 排队到 WS onOpen 之后再发。
    pvReady.then(() => pvRpc('meta')).then((m) => {
      // 标题栏现在显示"当前根名"：换根之后必须一眼看出看的是哪儿，
      // 完整路径挂在按钮 title 上。
      pvApplyRootMeta(m);
      pvRenderCrumbs();
      if (pv.pendingPath) {
        const p = pv.pendingPath;
        pv.pendingPath = '';
        pvRevealPath(p);
      } else if (pv.open) {
        pvLoadDir(pv.cwd);
      }
    }).catch((err) => {
      const label = $('#pv-root-name');
      if (label) label.textContent = '文件预览不可用';
      pvNote('无法读取工作目录：' + (err.message || String(err)), true);
    });

    pvRenderCrumbs();
    pvRenderTree();
  }

  /**
   * 从工具卡的参数文本里猜一个路径。
   * 只是"点一下试试"的便捷入口 —— 猜错了顶多打开失败并提示，不会误伤。
   * 优先多级路径（含 / 或 \），其次带扩展名的单词。
   */
  function pvPathFromDetail(detail) {
    if (!detail) return '';
    const s = String(detail);
    // 工具参数几乎都是 key="value" 形式 ⇒ 引号里的整体值最可信。
    // 不要用"看起来像路径的正则"去抠引号内部：路径里可能有空格
    // （C:\Program Files\...）、连续斜杠、中文目录名，规则越想周全越容易漏。
    const looksPath = (v) => /[/\\]/.test(v) || /\.[A-Za-z0-9]{1,8}$/.test(v);

    let p = '';
    const quoted = /["']([^"']{2,300})["']/.exec(s);
    if (quoted && looksPath(quoted[1])) p = quoted[1];

    if (!p) {
      // 没有引号 ⇒ 找裸路径：先要"有分隔符的"，再退到"带扩展名的单词"
      const m = /(?:^|[\s(,=])((?:[A-Za-z]:)?[^\s"'(){},]+[/\\][^\s"'(){},]+)/.exec(s)
        || /(?:^|[\s(,=])([\w.-]+\.[A-Za-z0-9]{1,8})\b/.exec(s);
      p = m ? m[1] : '';
    }
    if (!p) return '';
    // 折叠重复分隔符：`C://a//b` 这种（转义/拼接产物）也要认
    p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

    // 工具参数里通常是**绝对路径**，而预览只认工作区内相对路径。
    // 能剥掉工作区前缀就剥（这是最常见的情况）；剥不干净就当作不可点，
    // 而不是让用户点了之后收到一个 400。
    if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
      const root = String(pv.rootAbs || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (root && p.toLowerCase().startsWith(root.toLowerCase() + '/')) {
        return p.slice(root.length + 1);
      }
      return '';
    }
    return p.replace(/^\.\//, '');
  }

  function bindAttachments() {
    const btn = $('#chat-attach-btn');
    const input = $('#chat-file-input');
    const composer = $('#chat-composer');
    const ta = $('#chat-input');
    if (btn && input) {
      btn.onclick = () => input.click();
      input.onchange = () => {
        addImageFiles(input.files);
        input.value = '';       // 同一文件连选两次也要能触发 change ✓
      };
    }
    // 粘贴：只截「剪贴板里真有图片」的情况，纯文本粘贴保持默认行为 ✓
    if (ta) {
      ta.addEventListener('paste', (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        const imgs = [];
        for (const it of items) {
          if (it.kind === 'file' && /^image\//.test(it.type || '')) {
            const f = it.getAsFile();
            if (f) imgs.push(f);
          }
        }
        if (imgs.length) { e.preventDefault(); addImageFiles(imgs); }
      });
    }
    // 拖入：只认输入区（不做"整窗任意处都能拖" —— 那会抢掉页面里其它拖拽语义，
    // 比如未来给消息列表加"拖到此处引用文件"）
    const dropZone = composer || document.body;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    // 两种拖拽落点：外部文件（当图片附件）与预览栏里的文件（插入绝对路径）。
    // 用自定义 MIME 区分 —— 只有预览栏的 dragstart 会写入它，
    // 网页里拖来的文字/链接不会被误当成"工作区文件"。
    const PATH_MIME = 'application/x-hyacinth-path';
    const clearDropState = () => {
      dropZone.classList.remove('is-drag-over');
      dropZone.classList.remove('is-drag-path');
    };
    dropZone.addEventListener('dragover', (e) => {
      stop(e);
      const dt = e.dataTransfer;
      const isPath = !!(dt && dt.types && Array.prototype.includes.call(dt.types, PATH_MIME));
      dropZone.classList.toggle('is-drag-path', isPath);
      dropZone.classList.add('is-drag-over');
    });
    dropZone.addEventListener('dragleave', (e) => {
      stop(e);
      // 只有真正离开容器才撤高亮，否则子元素间移动会闪
      if (!dropZone.contains(e.relatedTarget)) clearDropState();
    });
    dropZone.addEventListener('drop', (e) => {
      stop(e);
      clearDropState();
      const dt = e.dataTransfer;
      const files = dt && dt.files;
      if (files && files.length) { addImageFiles(files); return; }
      const rel = dt && dt.getData ? dt.getData(PATH_MIME) : '';
      if (rel) insertComposerPath(pvAbsPath(rel));
    });
  }

  /**
   * 把一段路径插到输入框**光标处**（带引号，两侧按需补空格）。
   *
   * 为什么不是"追加到末尾"：用户常常先写半句话（"看下这个文件"）再拖文件进来，
   * 追加到末尾会让路径跑到句子外面。
   */
  function insertComposerPath(abs) {
    const ta = $('#chat-input');
    if (!ta || !abs) return;
    const quoted = '"' + abs + '"';
    const hasSel = typeof ta.selectionStart === 'number';
    const start = hasSel ? ta.selectionStart : ta.value.length;
    const end = hasSel ? ta.selectionEnd : ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + pre + quoted + post + after;
    const pos = (before + pre + quoted).length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* 老浏览器 */ }
    // 触发自动增高 / 发送按钮激活等既有监听
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.scrollTop = ta.scrollHeight;
  }

  function sendChat() {
    const input = $('#chat-input');
    if (!input) return;
    const text = input.value.trim();
    const images = pendingImages.slice();
    if (!text && !images.length) return;
    input.value = '';
    pendingImages = [];
    renderAttachments();
    // 忙碌中：入队到输入框上方队列面板（不硬插进对话），回合结束自动发下一条
    if (chatBusy) { enqueueSend(text, images); return; }
    dispatchChat(text, images);
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
      // 7) 操作（并行 / 加载 / 删除）
      const tdOps = document.createElement('td');
      tdOps.className = 'px-4 py-3 align-middle';
      const opsDiv = document.createElement('div');
      opsDiv.className = 'flex items-center justify-end gap-2';
      const parallelBtn = document.createElement('button');
      parallelBtn.className = 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs text-foreground hover:bg-muted transition-colors';
      parallelBtn.setAttribute('aria-label', 'Open session in parallel tab');
      parallelBtn.dataset.action = 'parallel';
      parallelBtn.title = '在新标签中并行打开（后台也能继续跑）';
      parallelBtn.innerHTML = '<i data-lucide="plus" class="w-3.5 h-3.5"></i><span>并行</span>';
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
      opsDiv.appendChild(parallelBtn);
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

  // ════════════════════════════════════════════════════════════
  // 侧栏「最近会话」（A4）
  // ════════════════════════════════════════════════════════════
  // 背景：此前续聊只能走 #/sessions → 找到目标行 → 点「加载」⇒ 高频动作多两次跳转 ✗。
  // 数据源与 #/sessions 同一处 `session.list`：协议层已按 activeRouter.name 过滤过
  // （src/ui-protocol/domains/session.ts:126-135），前端**不再按 type 过滤**，否则
  // 会把「按模式过滤」这件事写出第二份真相（两处不一致时前端更隐蔽 ✗）。
  const SIDEBAR_RECENT_LIMIT = 30;
  let sidebarRecentCache = [];

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / 日期。
   *  侧栏宽度只有 260px，复用 fmtSessionTime 的「YYYY-MM-DD HH:mm」会把标题挤没 ✗ */
  function fmtRecentTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    if (diff < 0) return '刚刚';                 // 时钟偏差：未来时间当作刚刚，别显示「-3 分钟前」
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    // 跨年才带上年份：同年显示 10-22 已够定位（且更短 ✓）
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return sameYear ? `${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 标题：SessionMeta 没有 title 字段（session.ts 只映射 id/createdAt/updatedAt/type/channel）
   *  ⇒ 用**创建时间**当标签，而不是 id 末 16 字符。
   *  理由：id 形如 `1023-13736-3e3b`，前缀是全天的会话共用的，末尾随机段对人没有辨识度；
   *  时间戳每个人都能立刻对上"那是我几点开的那个"。完整 id 仍放在 title 属性里可 hover 查看。 */
  function recentSessionTitle(s) {
    const t = (s && s.title) || '';
    if (t) return t;
    const c = s && s.createdAt ? new Date(s.createdAt) : null;
    if (c && Number.isFinite(c.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      const sameYear = c.getFullYear() === new Date().getFullYear();
      const day = `${p(c.getMonth() + 1)}-${p(c.getDate())}`;
      return `${sameYear ? day : c.getFullYear() + '-' + day} ${p(c.getHours())}:${p(c.getMinutes())}`;
    }
    const id = (s && s.id) || '';
    return id.length > 16 ? id.slice(-16) : id;
  }

  /** 侧栏高亮 = **当前可见标签**绑定的会话，而不是本页 connection（primary）的会话。
   *  否则切到并行标签后，聊天区显示 B、侧栏却还高亮 A —— 两处"选中的"互相矛盾。 */
  function activeSessionId() {
    const t = tabs.find((x) => x.id === activeTabId);
    return t ? tabSessionId(t) : currentSessionId;
  }

  /** 当前会话判定：会话目录可能以绝对路径 / basename 两种形态出现 ⇒ 两边都按
   *  basename 比一次，避免高亮失效 ✗ */
  function isCurrentSession(id) {
    if (!id) return false;
    const cur = activeSessionId();
    if (!cur) return false;
    return sameSession(id, cur);
  }

  function renderSidebarRecent() {
    const box = $('#sidebar-recent');
    const list = $('#sidebar-recent-list');
    if (!box || !list) return;

    // 搜索：纯前端过滤（列表本身就是当前模式的全部会话，数量在几十条量级，
    // 打到后端反而要新增协议方法）。空查询 = 不过滤。
    const q = (($('#session-search') || {}).value || '').trim().toLowerCase();
    let rows = sidebarRecentCache;
    if (q) {
      rows = rows.filter((s) => (recentSessionTitle(s) + ' ' + s.id).toLowerCase().includes(q));
    }
    // 有搜索词时不截断：用户找的就是"更早那条"，截断会让搜索显得坏掉
    if (!q) rows = rows.slice(0, SIDEBAR_RECENT_LIMIT);

    // 无会话 ⇒ 整块隐藏（不留空标题）；搜索无结果时保留框体，给一行提示
    box.hidden = rows.length === 0 && !q;
    list.innerHTML = '';
    if (rows.length === 0) {
      list.appendChild(el('div', 'sidebar-recent-empty', '没有匹配的会话'));
      return;
    }

    // 正在运行的会话 id：运行态只存在于标签上（primary + 各并行标签），
    // 侧栏只做投影 —— 不新增第二份"谁在跑"的真相。
    const runningIds = tabs
      .filter((t) => t.running)
      .map((t) => tabSessionId(t))
      .filter(Boolean);

    // 按「今天 / 昨天 / 更早」分组：平铺一列时，8 条里有 5 条是别的日子，
    // 时间戳要逐条读才知道新旧 —— 分组把"哪条是刚聊的"变成一眼可见。
    let lastGroup = null;
    for (const s of rows) {
      const group = dayBucket(s.updatedAt);
      if (group !== lastGroup) {
        list.appendChild(el('div', 'recent-group-label', group));
        lastGroup = group;
      }
      const current = isCurrentSession(s.id);
      const running = runningIds.some((rid) => sameSession(rid, s.id));
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sidebar-recent-item'
        + (current ? ' is-current' : '')
        + (running ? ' is-running' : '');
      row.dataset.sessionId = s.id;
      row.title = s.id;                       // 截断后的标题不可辨 ⇒ hover 给全 id
      if (running) {
        // 运行标记：动画本来就只在侧栏存在（标签条可能被隐藏/滚动掉）
        const dot = document.createElement('span');
        dot.className = 'sidebar-recent-dot';
        row.appendChild(dot);
      }
      const title = document.createElement('span');
      title.className = 'sidebar-recent-title';
      title.textContent = recentSessionTitle(s);
      const time = document.createElement('span');
      time.className = 'sidebar-recent-time';
      time.textContent = fmtRecentTime(s.updatedAt);
      row.appendChild(title);
      row.appendChild(time);
      row.addEventListener('click', () => openRecentSession(s.id));
      list.appendChild(row);
    }
  }

  /** 会话落到哪个时间桶。跨年/跨月的边界用「自然日」比较，不用 24h 差 —— 凌晨 1 点看
   *  23 小时前的消息，人在心理上会把它算作"昨天"，按 24h 差会错标成"今天"。 */
  function dayBucket(iso) {
    const t = new Date(iso || 0);
    if (!Number.isFinite(t.getTime())) return '更早';
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(t)) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return '本周';
    return '更早';
  }

  async function loadSidebarRecent() {
    if (!connected) return;
    try {
      const res = await client.request('session.list');
      const all = (res && res.sessions) || [];
      // 后端不保证顺序 ⇒ 自己按 updatedAt 倒序（同 renderSessions 的默认排序，app.js:1893-1897）
      sidebarRecentCache = all.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      renderSidebarRecent();
      syncTabTitles();
    } catch (e) {
      // 侧栏只是辅助入口：拉取失败就保持旧内容，不往聊天区塞错误打断对话 ✗
    }
  }

  /**
   * 删完会话后的跳转 —— **决策由后端给**（`session.delete` / `batchDelete` 应答里的
   * nextSessionId，见 domains/session.ts 的 settleAfterDelete）。
   *
   * 为什么不再在前端算："当前会话被删了，下一条消息该写到哪"是**会话语义**，
   * 不是视图语义。放在前端意味着 TUI 删当前会话时行为分叉，而且前端得自己拉列表、
   * 按 updatedAt 排序、判断"该不该切"—— 三件都可能与后端理解不一致。
   * 现在前端只做两件事：切过去、重画。
   *
   * @param res 协议应答；nextSessionId 为空表示"删的不是当前会话"，什么也不用做
   */
  async function applyDeleteSettle(res) {
    const nextId = res && res.nextSessionId;
    if (!nextId) return;
    try {
      currentSessionId = nextId;
      sessionSelection.delete(nextId);
      // 列表与侧栏都已由 session.change 事件刷新；这里补标题、清空消息区、重拉历史
      const item = (sidebarRecentCache || []).find((s) => s.id === nextId);
      setSessionTitle(item ? recentSessionTitle(item) : '新会话');
      clearChat();
      await loadHistory();
      appendMsg('system', res.createdNew
        ? '当前会话已删除，已新建一个会话'
        : '当前会话已删除，已切到「' + (item ? recentSessionTitle(item) : nextId) + '」');
    } catch (e) {
      appendMsg('error', '会话已删除，但切换视图失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /** 顶栏的「当前会话」名。此前整个顶部没有任何"我在哪条会话"的信息，
   *  切完会话只能从侧栏高亮去猜。空标题时回落「新会话」。 */
  function setSessionTitle(text) {
    const label = text || '新会话';
    // 2026-10-27（C 方案）：标题只写给**当前可见标签**，不再有「primary 永远代表本页」
    // 这一层。旧实现先改 primary 标题再判断是否更新可见标题，导致后台 primary 的
    // 变化会把用户眼前的标题改掉。
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) {
      if (active.title === label) return;
      active.title = label;
      renderTabs();           // renderTabs 内部会同步顶栏标题
      return;
    }
    const el = $('#session-title');
    if (el) el.textContent = label;
  }

  /** 侧栏点击会话：恢复 → 切换后端 loop → 重拉历史 */
  function openRecentSession(sid) {
    if (!connected || !sid) return;
    // 窄屏抽屉是覆盖层：不收起会盖住刚打开的历史（宽屏下该 class 无样式 ⇒ 无副作用 ✓）
    setNavDrawer(false);
    // 该会话已在某个标签里（含 primary）⇒ 直接切过去：
    // 用本页连接去 switch 会被后端占用表拒绝
    const openTab = tabForSession(sid);
    if (openTab) {
      goTo('#/chat');
      activateTab(openTab.id);
      return;
    }
    // 2026-10-27 重做：不再区分 primary 忙不忙 —— 没开过该会话就一律新开标签。
    // 旧版只在 primary 运行时才开标签，其余情况 session.switch 复用本页连接，
    // 导致「多会话并行」成了例外路径：想开第二个会话得先让第一个跑起来。
    // 新语义：一条会话 = 一个标签 = 一条 WS = 一个独立 AgentLoop，地位平等。
    if (openSessionInTab(sid)) return;
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
        goTo('#/chat');
        // 空会话 = 不带 session 参数的连接（后端自铸 id + lazySession，首条消息才落盘）
        openSessionInTab(null, '已新建空会话（发出第一条消息后才会保存）');
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
        if (action === 'parallel') {
          if (!connected) return;
          goTo('#/chat');
          openSessionTab(sid);
        } else if (action === 'load') {
          if (!connected) return;
          // 已开在并行标签里 ⇒ 切过去（用本页连接再 switch 会被后端占用表拒绝）
          const openTab = tabForSession(sid);
          if (openTab) {
            goTo('#/chat');
            activateTab(openTab.id);
            return;
          }
          // 2026-10-27：sessions 页「加载」也走统一入口 —— 没开过就开新标签，
          // 不再 session.switch 顶掉本页正在聊的那条会话。
          if (openSessionInTab(sid, '已加载会话 ' + sid)) return;
        } else if (action === 'delete') {
          if (!connected) return;
          client.request('session.delete', { sessionId: sid }).then((res) => {
            appendMsg('system', '已删除会话 ' + sid);
            sessionSelection.delete(sid);
            loadSessions();
            // 侧栏由 session.change 事件刷新；这里只做"当前会话被删了"的视图收尾
            void applyDeleteSettle(res);
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
          void applyDeleteSettle(res);
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
    ['toggle-bypass-agents', 'bypass.orchestratorEnabled', 'bool'],
    ['input-max-context', 'session.maxContext', 'num'],
    // 单次最大输出（wire 的 max_tokens）。0 = 使用当前模型的上限（默认行为）。
    ['input-max-output', 'provider.maxOutputTokens', 'num'],
    ['input-max-messages', 'session.maxMessages', 'num'],
    ['input-kb-max-total', 'kb.maxTotal', 'num'],
    ['input-kb-max-main', 'kb.maxMain', 'num'],
    ['input-kb-max-refs', 'kb.maxRefs', 'num'],
    ['toggle-watch-prompts', 'hotReload.watchPrompts', 'bool'],
    // 轮次 tab
    ['input-max-turns', 'session.maxTurns', 'num'],
    ['input-max-messages-turns', 'session.maxMessages', 'num'],
    ['toggle-reasoning-tokens', 'provider.showThinking', 'bool'],
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
    // 修复 tab
    ['toggle-auto-retry', 'resiliency.retry.enabled', 'bool'],
    ['input-max-retries', 'resiliency.retry.maxRetries', 'num'],
    ['toggle-sanitize', 'tools.sanitize', 'bool'],
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
  // ── 系统面板（设置页「系统」tab；2026-09-20）──────────────────────────
  // 用户指出的方向：**Web 有交互能力 ⇒ 该给能点的东西，不该学终端去发命令** ✓
  // 接三个后端已实测可用的能力：orchestrator / state.stats / process ✓
  let systemBound = false;

  function toggleSwitchStyle(el2, on) {
    if (!el2) return;
    el2.checked = !!on;
  }

  async function loadOrchestrator() {
    const desc = $('#orch-desc');
    const sw = $('#orch-toggle');
    try {
      const r = await client.request('orchestrator.get');
      const o = (r && r.orchestrator) || {};
      toggleSwitchStyle(sw, o.active);
      const agents = Array.isArray(o.activeAgents) ? o.activeAgents : [];
      if (desc) desc.textContent = o.active ? ('已启用' + (agents.length ? ' · 运行中：' + agents.join('、') : '')) : '未启用（开启后由编排器按复杂度分派旁路智能体）';
    } catch (e) {
      if (desc) desc.textContent = '取不到状态：' + ((e && e.message) || '未知错误');
    }
  }

  async function loadSessionStats() {
    const desc = $('#session-stats-desc');
    if (!desc) return;
    if (!currentSessionId) { desc.textContent = '（当前没有会话）'; return; }
    try {
      const r = await client.request('state.stats', { sessionId: currentSessionId });
      const s = (r && r.stats) || {};
      const bits = [];
      if (s.turn_count != null) bits.push('轮次 ' + s.turn_count);
      if (s.input_tokens != null || s.output_tokens != null) bits.push('token ↑' + (s.input_tokens || 0) + ' / ↓' + (s.output_tokens || 0));
      if (s.current_context_tokens != null) bits.push('当前上下文 ' + fmtTokens(s.current_context_tokens));
      if (s.compact_count != null) bits.push('压缩 ' + s.compact_count + ' 次');
      desc.textContent = bits.length ? bits.join(' · ') : JSON.stringify(s);
    } catch (e) {
      desc.textContent = '取不到统计：' + ((e && e.message) || '未知错误');
    }
  }

  async function loadProcesses() {
    const box = $('#proc-list');
    const cnt = $('#proc-count');
    if (!box) return;
    let list = [];
    try {
      const r = await client.request('process.list');
      list = (r && r.processes) || [];
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'settings-desc', '取不到进程列表：' + ((e && e.message) || '未知错误')));
      return;
    }
    if (cnt) cnt.textContent = list.length ? list.length + ' 个' : '';
    box.innerHTML = '';
    if (!list.length) {
      box.appendChild(el('div', 'settings-desc', '当前没有后台进程 ✓（长跑任务会出现在这里）'));
      return;
    }
    list.forEach((p) => {
      const row = el('div', 'settings-row');
      const left = el('div');
      left.appendChild(el('div', 'settings-label font-mono', p.handle || p.id || '—'));
      const meta = [p.command, p.description, p.status, p.startedAt].filter(Boolean).join(' · ');
      if (meta) left.appendChild(el('div', 'settings-desc', meta));
      row.appendChild(left);
      const kill = el('button', 'settings-input', '终止');
      kill.style.cssText += ';cursor:pointer;font-family:inherit;color:var(--state-error)';
      kill.onclick = () => {
        if (!connected) return;
        kill.disabled = true;
        client.request('process.kill', { handle: p.handle || p.id })
          .then(() => { appendMsg('system', '已终止进程 ' + (p.handle || p.id)); loadProcesses(); })
          .catch((e) => { kill.disabled = false; appendMsg('error', '终止失败: ' + (e && e.message)); });
      };
      row.appendChild(kill);
      box.appendChild(row);
    });
  }

  // ── 运行时监督（supervisor.status）────────────────────────────
  // 「我的 GUI」的观测面：进程 / 守护 / 上次重启 / 热重载 watcher / git 工作区 / 内核插件。
  // 协议契约：watchers 与 git 是**可选**字段 —— 后端未注入时协议层返回 null。
  // ⇒ 必须把「未提供」与「取不到」分开显示，否则会把"没接上"误读成"坏了"。
  function fmtUptime(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '—';
    const d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600);
    const m = Math.floor((n % 3600) / 60), s = Math.floor(n % 60);
    if (d) return `${d} 天 ${h} 小时`;
    if (h) return `${h} 小时 ${m} 分`;
    if (m) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  /**
   * 截断长文本。UI 里任何「长度不可控」的字段都必须过它。
   * 教训（2026-10-16 实测）：supervisor.status 的 lastRestart.detail 是一整段
   * 收尾说明（数百字），直接塞进 settings-desc 会把卡片撑变形。
   */
  function cut(s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  async function loadSupervisor() {
    const setText = (sel, text) => { const n = $(sel); if (n) n.textContent = text; };
    try {
      const s = await client.request('supervisor.status');
      if (!s) throw new Error('空响应');
      let proc = `pid ${s.pid} · ${s.node}` + (s.guardian ? ' · 守护中' : ' · 无守护');
      if (s.lastRestart) {
        const r = typeof s.lastRestart === 'object'
          ? (s.lastRestart.reason || JSON.stringify(s.lastRestart))
          : String(s.lastRestart);
        proc += ' · 上次重启：' + cut(r, 60);
      }
      setText('#sup-uptime', '运行 ' + fmtUptime(s.uptimeSec));
      setText('#sup-proc', proc);
      setText('#sup-watchers', s.watchers
        ? (s.watchers.started ? '已启动' : '未启动') +
          ` · ${s.watchers.watcherCount} 个 watcher · 合并窗口 ${s.watchers.debounceMs}ms`
        : '未提供（后端未注入）');
      setText('#sup-git', s.git
        ? (s.git.isRepo ? (s.git.dirty ? '有未提交改动' : '工作区干净') : '不是 git 仓库') +
          (s.git.lastAutoCommit ? ' · 最近自动提交：' + cut(s.git.lastAutoCommit, 60) : '')
        : '未提供（后端未注入）');
      const ps = Array.isArray(s.plugins) ? s.plugins : [];
      setText('#sup-plugins', ps.length
        ? ps.map((p) => `${p.id}（${p.state === 'mounted' ? '已挂载' : '错误' + (p.error ? '：' + cut(p.error, 40) : '')}）`).join(' · ')
        : '无');
    } catch (e) {
      setText('#sup-uptime', '取不到监督状态：' + ((e && e.message) || '未知错误'));
    }
  }

  function loadSystemPanel() {
    bindSystemOnce();
    loadOrchestrator();
    loadSessionStats();
    loadProcesses();
    loadSupervisor();
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
  }

  function bindSystemOnce() {
    if (systemBound) return;
    const sw = $('#orch-toggle');
    if (!sw) return;
    systemBound = true;
    sw.onchange = () => {
      if (!connected) { sw.checked = !sw.checked; return; }
      sw.disabled = true;
      client.request('orchestrator.setEnabled', { enabled: sw.checked })
        .then((r) => {
          const o = (r && r.orchestrator) || {};
          appendMsg('system', '编排器已' + (o.active ? '启用' : '停用'));
          loadOrchestrator();
        })
        .catch((e) => { sw.checked = !sw.checked; appendMsg('error', '切换失败: ' + (e && e.message)); })
        .finally(() => { sw.disabled = false; });
    };
    const rf = $('#system-refresh-btn');
    if (rf) rf.onclick = () => { loadSystemPanel(); };
  }

  function loadSettings() {
    if (!connected) return;
    loadVoiceSettings();   // 语音分区（status/config 独立拉取，进设置页即刷新）
    loadTtsSettings();     // 语音合成（tts.status 独立拉取）
    loadModelsRoot();      // 模型存储位置（stt/tts 共用的生效目录）
    client.request('config.getAll').then(async (cfg) => {
      if (!cfg) return;
      SETTINGS_MAP.forEach(([domId, path, type]) => applySettingValue(domId, path, type, cfg));
      // Zone 开关（zone1/2/3/5）：manifest 真源（.agent/context-manifest.json）
      loadManifestZoneToggles().catch(() => {});
      loadSystemPanel();   // 系统面板（开关/统计/进程 ✓）
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
      companionDefaultCharacter = getByPath(cfg, 'companion.defaultCharacter') || '';
      // 主题：ui.theme（用户偏好，存全局配置）
      const theme = getByPath(cfg, 'ui.theme');
      if (typeof theme === 'string' && theme) applyTheme(theme);
      // 代码高亮配色：ui.codeTheme（同样是用户偏好）
      const codeTheme = getByPath(cfg, 'ui.codeTheme');
      if (typeof codeTheme === 'string' && codeTheme) applyCodeTheme(codeTheme);
          }).catch((e) => appendMsg('error', '读取配置失败: ' + ((e && e.message) || '未知错误')));
  }

  // ════════════════════════════════════════════════════════════
  // 主题（Theme）
  // ────────────────────────────────────────────────────────────
  // 主题由 theme.css 的 html[data-theme="x"] 定义（只覆盖调色板变量），
  // 这里负责：卡片渲染 / 应用 / 持久化到后端 ui.theme。
  // ════════════════════════════════════════════════════════════

  /**
   * 主题目录：**运行时读 /themes.json**，不再在这里手抄一份。
   * 旧实现是 8 条硬编码（连 dark/glass/ink/rainy 都缺），主题从 12 套扩到 20 套后
   * 必然对不上 —— 而且两份真源迟早分叉。这里是唯一的兜底，只在 fetch 失败时用。
   */
  let THEMES = [
    { id: 'hyacinth', name: '夜园', desc: '夜色 · 月光蓝一处信号', swatches: ['#0a0c12', '#0f1219', '#6ba6f0', '#2fb3a4', '#e9edf5'] },
  ];
  let THEME_IDS = THEMES.map((t) => t.id);
  let THEME_GROUPS = null;
  /**
   * 各主题是明是暗 —— 只服务于「代码配色 = 跟随主题」：那一档要按主题的明暗
   * 换一套代码配色，否则浅色主题配深色代码底会非常刺眼。
   * 真源是 themes.json 的 dark 字段；目录拿不到时按"hyacinth 是暗色"兜底。
   */
  let THEME_DARK = new Set(['hyacinth']);

  /** 从 themes.json 组装卡片数据。swatches 取「底 / 面 / 主 / 强调 / 字」五格。 */
  function themeCardData(t) {
    const p = t.palette || {};
    const pick = (...keys) => { for (const k of keys) { if (p[k]) return p[k]; } return null; };
    return {
      id: t.id,
      name: String(t.label || t.id).split('·')[0].trim(),
      desc: t.label || '',
      swatches: [
        pick('neutral-50', 'neutral-0'),
        pick('neutral-100', 'neutral-150'),
        pick('primary-500', 'primary-400'),
        pick('accent-500', 'accent-400'),
        pick('neutral-900', 'neutral-800'),
      ].filter(Boolean),
    };
  }

  async function loadThemeCatalog() {
    let ok = false;
    try {
      const r = await fetch('/themes.json', { cache: 'no-cache' });
      if (r.ok) {
        const data = await r.json();
        const list = Array.isArray(data.themes) ? data.themes : [];
        if (list.length) {
          THEMES = list.map(themeCardData);
          THEME_IDS = THEMES.map((t) => t.id);
          THEME_DARK = new Set(list.filter((t) => t.dark === true).map((t) => t.id));
          THEME_GROUPS = data.groups || null;
          ok = true;
          // 目录到齐：先给启动时"暂缓"的主题补做校验（可能修正 currentTheme），
          // 再渲染卡片，选中态才是准的。
          settleThemeCatalog(true);
          const grid = $('#theme-grid');
          if (grid) { grid.dataset.rendered = ''; grid.innerHTML = ''; }
          renderThemes();
        }
      }
    } catch (e) { /* 目录读不到就用手上的兜底，不影响换肤本身 */ }
    finally {
      // 上面的 return / 抛错都会汇到这里：目录拿不到也必须结束"暂缓"状态，
      // 否则页面会永久停在"目录未就绪"分支（属性设了却从不持久化、也从不被校验）。
      // 传 false = 这次没拿到真源，不要按兜底目录去做回落判定。幂等。
      settleThemeCatalog(ok);
    }
  }
  let currentTheme = 'hyacinth';

  // ── 用户自备背景图（assets/bg/<主题id>.webp|jpg|png）─────────────
  // build 时 scripts/gen-bg-manifest.cjs 生成 assets/bg/_manifest.json（{id:文件名}）。
  // 前端先读清单，**只请求存在的图** ⇒ 缺图不再产生 404（2026-10-28 修控制台噪音）。
  const userBgCache = {};
  let bgManifestPromise = null;
  function loadBgManifest() {
    if (!bgManifestPromise) {
      bgManifestPromise = fetch('assets/bg/_manifest.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    }
    return bgManifestPromise;
  }

  function applyUserBg(file) {
    if (file) document.documentElement.style.setProperty('--hyacinth-user-bg', `url("${file}")`);
    else document.documentElement.style.removeProperty('--hyacinth-user-bg');
  }

  function probeUserBg(id) {
    if (id in userBgCache) { applyUserBg(userBgCache[id]); return; }
    loadBgManifest().then((manifest) => {
      const file = manifest && manifest[id];
      if (file) {
        const url = `assets/bg/${file}`;
        userBgCache[id] = url;
        if (currentTheme === id) applyUserBg(url);
      } else {
        userBgCache[id] = null; // 清单里没有 ⇒ 不请求、回落到主题自带背景画
        if (currentTheme === id) applyUserBg(null);
      }
    });
  }

  /**
   * 主题目录是否已「尘埃落定」——themes.json 到手，或已确认拿不到。
   * 在它为 false 之前，applyTheme 绝不能按 THEME_IDS 判定"这个 id 不存在"：
   * 那时目录里只有兜底的 1 条 hyacinth，任何真实主题都会被误判成无效。
   */
  let themeCatalogReady = false;
  /** 目录**真的拿到了**（区别于"加载流程结束但没拿到"）：只有它为真，才按目录判定 id 有效性 */
  let themeCatalogOk = false;
  /** 目录就绪前收到的主题 id，等目录到齐再补做一次校验与持久化 */
  let pendingThemeId = null;

  /**
   * 应用主题。
   *
   * 关键：theme.css 是**全量静态**的（20 套主题同在一个文件里，形如
   * `html[data-theme='mono']`），所以只要把属性写到 <html> 上样式立即生效，
   * **不需要等 JS 目录**。旧实现把「写属性」和「按目录校验」绑在一起，
   * 导致启动时（目录还没 fetch 回来）任何非 hyacinth 的 id 都被静默回落成
   * hyacinth，还把回落值写回 localStorage —— 表现为"选了极简，重启还是黑的，
   * 点开设置页才变白"（设置页会读后端 ui.theme 再调一次 applyTheme，那时目录早到了）。
   */
  /**
   * 告诉 CSS 当前界面主题是明还是暗 —— 只有「代码配色 = 跟随主题」会用。
   * 主题目录还没到手时按兜底表判（默认暗），目录到齐后 applyTheme 会再走一遍。
   */
  function applyCodeTone(themeId) {
    document.documentElement.setAttribute('data-code-tone', THEME_DARK.has(themeId) ? 'dark' : 'light');
  }


  function applyTheme(name) {
    // 目录未就绪 + id 不在兜底目录里 ⇒ 无法判定真假。先把属性写上去（样式照常生效），
    // 记下来等目录到齐再校；**不回落、不写 localStorage**，避免把误判结果固化。
    if (!themeCatalogReady && THEME_IDS.indexOf(name) < 0) {
      pendingThemeId = name;
      currentTheme = name;
      document.documentElement.setAttribute('data-theme', name);
      applyCodeTone(name);
      probeUserBg(name);
      syncThemeCards(name);
      return;
    }

    // 只有目录**真的拿到了**才用它判定"id 不存在"。目录加载失败时保持用户的选择：
    // theme.css 是独立随包发布的静态产物，即使 themes.json 取不到，属性照样可能命中
    // 真实主题 —— 这时候按兜底目录（仅 1 条）去回落，只会把用户已选的主题打回默认。
    const id = THEME_IDS.indexOf(name) >= 0 ? name : (themeCatalogOk ? 'hyacinth' : name);
    currentTheme = id;
    document.documentElement.setAttribute('data-theme', id);
    applyCodeTone(id);
    // 本地缓存：下次加载立即应用，避免等待后端连接造成闪烁
    try { localStorage.setItem('hyacinth.theme', id); } catch (e) { /* 隐私模式忽略 */ }
    probeUserBg(id);
    syncThemeCards(id);
    // 同步对话区 iframe（同源）：否则切主题后 iframe 内文档停旧主题 => 侧栏深/对话区白（2026-10-28 修）
    try { document.querySelectorAll('iframe.chat-pane-frame').forEach(function (fr) { try { var d = fr.contentDocument; if (d && d.documentElement) d.documentElement.setAttribute('data-theme', id); } catch (_) {} }); } catch (_) {}
    notifyShellTheme();
  }

  /**
   * 把页面底色与明暗报给桌面壳（WebView2 宿主）。壳用 DWM 把**系统标题栏**染成
   * 同一颜色（caption 与页面顶栏融为一体、边框只剩阴影勾边），并按明暗切换
   * 系统 caption 按钮的深浅 —— 窗口结构是原生系统边框，壳不碰任何 NC 消息。
   * 仅 WebView2 环境有 window.chrome.webview；普通浏览器打开时静默跳过。
   */
  function notifyShellTheme() {
    try {
      const host = window.chrome && window.chrome.webview;
      if (!host || typeof host.postMessage !== 'function') return;
      const bg = getComputedStyle($('#app-shell')).backgroundColor;
      if (!bg) return;
      const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(bg);
      const dark = !m || (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) < 128;
      host.postMessage(JSON.stringify({ type: 'hyacinth-theme', background: bg, dark }));
    } catch (e) { /* 序列化失败/宿主不可用都不影响页面 */ }
  }

  /** 同步主题卡片选中态（grid 还没渲染时无副作用，由 renderThemes 用 currentTheme 兜住） */
  function syncThemeCards(id) {
    const grid = $('#theme-grid');
    if (!grid) return;
    grid.querySelectorAll('.theme-card').forEach((card) => {
      card.setAttribute('aria-pressed', card.dataset.theme === id ? 'true' : 'false');
    });
  }

  /**
   * 目录到手（或确认拿不到）后补做一次校验，把之前"暂缓"的主题定下来。
   * 幂等：重复调用只会在第一次消费 pending，之后退化为"确认当前属性仍有效"。
   */
  function settleThemeCatalog(ok) {
    themeCatalogReady = true;
    themeCatalogOk = ok === true;
    const pending = pendingThemeId;
    pendingThemeId = null;
    if (pending) { applyTheme(pending); return; }
    // 没有待定项：确认当前属性仍有效（例如旧版本留下的、已被删掉的主题 id）。
    // 目录没拿到时不校验 —— 见 applyTheme 里同样的理由。
    const attr = document.documentElement.getAttribute('data-theme');
    if (!attr || (themeCatalogOk && THEME_IDS.indexOf(attr) < 0)) applyTheme(attr || 'hyacinth');
  }

  /** 启动时先用本地缓存主题（避免闪烁），连上后端后再以 ui.theme 为准 */
  function initThemeFromCache() {
    let cached = null;
    try { cached = localStorage.getItem('hyacinth.theme'); } catch (e) { /* ignore */ }
    if (cached && /^[a-z][a-z0-9-]{1,24}$/.test(cached)) applyTheme(cached);
    else applyTheme('hyacinth');
  }

  // ── 代码高亮配色（与界面主题正交：主题管界面，这里只管代码块）──────
  // ⚠️ 与 src/webui/code-themes.css 是**两处真源**：CSS 里给每个 id 定义变量，
  //    这里给每个 id 定义卡片。新增配色两边都要加，漏 CSS 那处 = 选了没变化。
  const CODE_THEMES = [
    { id: 'auto', name: '跟随主题' },
    { id: 'hyacinth', name: '月光蓝' },
    { id: 'monokai', name: 'Monokai' },
    { id: 'dracula', name: 'Dracula' },
    { id: 'nord', name: 'Nord' },
    { id: 'one-dark', name: 'One Dark' },
    { id: 'solarized-dark', name: 'Solarized Dark' },
    { id: 'github-light', name: 'GitHub Light' },
    { id: 'one-light', name: 'One Light' },
    { id: 'solarized-light', name: 'Solarized Light' },
    { id: 'xcode', name: 'Xcode' },
  ];
  const CODE_THEME_IDS = CODE_THEMES.map((t) => t.id);

  /**
   * 卡片预览用的示例代码（hljs 的 token 类，配色由 CSS 变量决定）。
   * 手写而不是现跑 hljs：**设置页打开时引擎可能还没加载**（按需加载），
   * 而且这四行是固定内容，没必要为它引入一次高亮。
   */
  const CODE_SAMPLE =
    '<span class="hljs-keyword">def</span> <span class="hljs-title function_">throttle</span>'
    + '(<span class="hljs-params">cur, limit=<span class="hljs-number">2.1</span></span>):\n'
    + '    <span class="hljs-comment"># 频率被锁在 limit</span>\n'
    + '    <span class="hljs-keyword">return</span> <span class="hljs-built_in">abs</span>'
    + '(cur - limit) &lt; <span class="hljs-number">1e-6</span>';

  let currentCodeTheme = 'auto';

  function applyCodeTheme(id) {
    const valid = CODE_THEME_IDS.indexOf(id) >= 0 ? id : 'auto';
    currentCodeTheme = valid;
    document.documentElement.setAttribute('data-code-theme', valid);
    try { localStorage.setItem('hyacinth.codeTheme', valid); } catch (e) { /* 隐私模式忽略 */ }
    syncCodeThemeCards(valid);
  }

  function syncCodeThemeCards(id) {
    const grid = $('#code-theme-grid');
    if (!grid) return;
    grid.querySelectorAll('.code-theme-card').forEach((card) => {
      card.setAttribute('aria-pressed', card.dataset.id === id ? 'true' : 'false');
    });
  }

  function renderCodeThemes() {
    const grid = $('#code-theme-grid');
    if (!grid || grid.dataset.rendered === '1') return;
    grid.dataset.rendered = '1';
    CODE_THEMES.forEach((t) => {
      const card = el('button', 'code-theme-card');
      card.type = 'button';
      // 卡片自带 data-code-theme ⇒ 预览块用的是**这套配色自己的**变量，
      // 而不是当前全局配色 —— 否则所有卡片长得一模一样，选了也没法比。
      // 注意 data-code-theme 是"预览用哪套色"，身份另存 data-id：
      // 「跟随主题」的预览借用 hyacinth 的色，若用同一个属性判选中态，
      // 选中 hyacinth 时会有两张卡片同时高亮。
      card.dataset.codeTheme = t.id === 'auto' ? 'hyacinth' : t.id;
      card.dataset.id = t.id;
      card.setAttribute('aria-pressed', t.id === currentCodeTheme ? 'true' : 'false');
      card.title = t.name;

      const name = el('span', 'code-theme-name');
      name.appendChild(el('span', null, t.name));
      name.appendChild(el('span', 'code-theme-check', '✓ 当前'));
      card.appendChild(name);

      const sample = el('pre', 'code-theme-sample');
      sample.innerHTML = CODE_SAMPLE;
      card.appendChild(sample);

      card.onclick = () => {
        applyCodeTheme(t.id);
        if (connected) {
          client.request('config.set', { path: 'ui.codeTheme', value: t.id }).catch((e) => {
            appendMsg('error', '保存代码配色失败: ' + ((e && e.message) || '未知错误'));
          });
        }
      };
      grid.appendChild(card);
    });
  }

  /** 启动时先用本地缓存（避免代码块先以默认色闪一下） */
  function initCodeThemeFromCache() {
    let cached = null;
    try { cached = localStorage.getItem('hyacinth.codeTheme'); } catch (e) { /* ignore */ }
    applyCodeTheme(cached && CODE_THEME_IDS.indexOf(cached) >= 0 ? cached : 'auto');
  }

  /** 渲染主题卡片网格 */
  function renderThemes() {
    const grid = $('#theme-grid');
    if (!grid || grid.dataset.rendered === '1') return;
    grid.dataset.rendered = '1';

    // 分组：themes.json 里有 groups 就按「暗色 / 浅色 / 特殊」分段，20 套平铺会找不到
    // 自己在哪。没有 groups（兜底路径）就退回单段。
    const order = ['dark', 'light', 'special'];
    const labelOf = { dark: '暗色', light: '浅色', special: '特殊' };
    const grouped = THEME_GROUPS && order.some((g) => Array.isArray(THEME_GROUPS[g]));

    const emit = (t) => {
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
    };

    if (!grouped) {
      THEMES.forEach(emit);
      return;
    }
    for (const g of order) {
      const ids = Array.isArray(THEME_GROUPS[g]) ? THEME_GROUPS[g] : [];
      const list = ids.map((id) => THEMES.find((t) => t.id === id)).filter(Boolean);
      if (!list.length) continue;
      grid.appendChild(el('div', 'theme-group-label', labelOf[g]));
      list.forEach(emit);
    }
    // 兜底：groups 里漏掉的 id 也要显示，否则用户会以为主题丢了
    const listed = new Set(order.flatMap((g) => (Array.isArray(THEME_GROUPS[g]) ? THEME_GROUPS[g] : [])));
    const orphans = THEMES.filter((t) => !listed.has(t.id));
    if (orphans.length) {
      grid.appendChild(el('div', 'theme-group-label', '未分组'));
      orphans.forEach(emit);
    }
  }

  // ── 设计语言（布局范式 + 交互规范，与主题正交）────────────────
  
  // 绑定设置视图交互：控件 change → config.set；重置按钮 → config.reset
  function bindSettingsView() {
    // ⚠️ 「默认模式」这里**不再写 localStorage 缓存**（2026-10-16 移除）：它曾与后端配置
    //   构成两个真源，且会在配置经**别的渠道**变更后变陈旧 ⇒ 页面按陈旧值跳错视图
    //   （实测：config=normal 而页面停在 #/companion）。
    //   本控件现在只负责写 config（由 SETTINGS_MAP 的通用绑定完成 config.set）；
    //   「启动时进哪个模式」的读取与跳转一律问后端（ui.connected → config.get）。
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
        /* 二次确认：这是**全部**配置恢复出厂，不可撤销。对照——删除语音模型/会话/
           音色/工具包、断开 MCP 全都 confirm，唯独这个最狠的漏了。 */
        if (!window.confirm('将所有配置恢复为出厂默认值？\n\n这会重置温度、上下文预算、Zone 开关、工具包等全部设置，且不可撤销。')) return;
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
  // 场景刷新已改为事件驱动（后端推 companion.scene）⇒ 不再有轮询定时器

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

  // ── say 语音播报（say-voice 插件事件）：交付正文的朗读 ──
  // 只出声，不留控件：say 的语义是 agent「说话」，消息流里不该出现媒体播放条
  // （那是"音频文件"的语义，且播放条在事件驱动下常停在 0:00/0:00 的坏态）。
  // 新一句直接打断上一句（说话不会排队等上一句播完）。
  let sayVoiceAudio = null;
  function handleSayVoice(payload) {
    if (!payload) return;
    if (payload.state === 'error') {
      appendMsg('status', '🔇 语音播报失败：' + (payload.message || '未知原因'));
      return;
    }
    if (!payload.audioWavBase64) return;
    try {
      if (sayVoiceAudio) sayVoiceAudio.pause();
      const audio = new Audio('data:audio/wav;base64,' + payload.audioWavBase64);
      sayVoiceAudio = audio;
      void audio.play().catch(() => { /* 自动播放被拦截：静默，文字交付不受影响 */ });
    } catch (e) { /* 播放失败静默：文字交付不受影响 */ }
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
      // 方案A：陪伴 = 独立会话标签。进陪伴 = 确保角色会话存在 + 开一个**独立标签**
      // （不 companion.activate 劫持当前会话）。该标签内 iframe 识别为 companion → 渲染沉浸视图。
      const res = await client.request(
        'companion.ensureSession',
        companionDefaultCharacter ? { character: companionDefaultCharacter } : {},
      );
      const char = (res && res.character) || companionDefaultCharacter;
      if (!char) { appendMsg('error', '没有可用的陪伴角色，请先在 设置→模式 创建'); return; }
      const tab = openSessionInTab(char);
      if (!tab) appendMsg('error', '打开陪伴标签失败（可能已达标签上限）');
    } catch (e) {
      appendMsg('error', '打开陪伴失败: ' + ((e && e.message) || '未知错误'));
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
      // 场景：先启动 demo 兜底，再尝试真实场景（有 scene.png 则切换为 live 单图）。
      // 后续变化由后端**推送** companion.scene 事件驱动（后端监视 scene.json 落盘）
      // —— 此前是每 15s 拉一次（companionScenePollTimer），已改为事件驱动 ✓
      companionStartScene();
      await loadCompanionScene();
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
      /* 方案 C：不再平铺工具名，改成「展开 N 个工具」按钮 + 按需渲染的明细容器 */
      if (b.tools && b.tools.length) {
        const detail = el('div', 'hidden flex-col divide-y divide-border border border-border rounded-lg overflow-hidden mt-1');
        const toggleBtn = el('button', 'self-start inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background text-xs hover:bg-muted transition-colors');
        toggleBtn.type = 'button';
        toggleBtn.innerHTML = '<i data-lucide="chevron-down" class="w-3 h-3"></i><span>展开 ' + b.tools.length + ' 个工具</span>';
        let opened = false;
        toggleBtn.onclick = () => {
          opened = !opened;
          if (opened) {
            renderBundleTools(b.name, detail);
            detail.classList.remove('hidden');
            detail.classList.add('flex');
            toggleBtn.querySelector('span').textContent = '收起工具';
          } else {
            detail.classList.add('hidden');
            detail.classList.remove('flex');
            toggleBtn.querySelector('span').textContent = '展开 ' + b.tools.length + ' 个工具';
          }
          if (window.lucide) { try { lucide.createIcons(); } catch (e) { /* ignore */ } }
        };
        row.appendChild(toggleBtn);
        row.appendChild(detail);
      } else {
        row.appendChild(el('div', 'text-[11px] text-muted-foreground', '全量（不限制工具）'));
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

  // ── 工具（方案 C：明细挂在各自工具包下，点开包才显示）──────────
  // 为什么这么做：全局平铺 309 个工具 ⇒ 卡片 13538px、DOM 712KB、约 1500 个可点目标，
  //   而且那个启停开关是**内存级**（与会话同生命周期），放在「设置」里极易被误认为持久配置。
  //   改成「只看包 → 点开看明细」，默认视野里只有 16 个包。
  let bundleNamesCache = [];
  let toolsCache = [];   // tool.list 全量结果，包展开时从这里过滤

  /** 拉一次全量工具数据（供各包展开时过滤），并刷新「未归类」区。不再渲染全局大列表。 */
  async function loadTools() {
    try {
      const res = await client.request('tool.list');
      if (res && res.tools) toolsCache = res.tools;
      if (bundleNamesCache.length === 0) {
        try {
          const bres = await client.request('tool.bundles');
          if (bres && bres.bundles) bundleNamesCache = bres.bundles.map((b) => b.name);
        } catch (e) { /* 忽略：下拉会退化为空 */ }
      }
    } catch (e) {
      console.error('[tools] tool.list 失败:', (e && e.message) || e);
    }
    renderUngroupedTools();
  }

  /** 单个工具行（原 loadTools 的行渲染抽出来，包展开时复用） */
  function makeToolRow(t) {
    const row = el('div', 'px-3 py-2 flex items-center gap-2 flex-wrap bg-card');
    row.appendChild(el('span', 'font-mono text-xs text-foreground w-56 shrink-0 truncate', t.name));

    const source = t.source || 'builtin';
    if (source !== 'builtin') {
      row.appendChild(makeBadge(
        source === 'mcp' ? ('MCP' + (t.mcpServer ? ' · ' + t.mcpServer : '')) : source,
        source === 'mcp' ? 'var(--hyacinth-accent, var(--state-info))' : 'var(--muted-foreground)',
      ));
    }

    const status = t.bundleFiltered ? '被过滤' : (t.enabled ? '可用' : '已禁用');
    const statusColor = t.bundleFiltered ? 'var(--state-warning)' : (t.enabled ? 'var(--state-success)' : 'var(--state-error)');
    row.appendChild(makeBadge(status, statusColor));

    (t.bundles || []).forEach((bname) => { row.appendChild(makeBundleChip(bname, t.name)); });
    if (t.description) {
      row.appendChild(el('span', 'text-xs text-muted-foreground flex-1 min-w-[120px] truncate', t.description));
    }
    row.appendChild(makeAddToBundleSelect(t.name, t.bundles || []));

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
    return row;
  }

  /** 把某个包的工具明细渲染进容器（点开包时调用） */
  function renderBundleTools(bundleName, container) {
    container.innerHTML = '';
    const list = toolsCache.filter((t) => (t.bundles || []).includes(bundleName));
    if (!list.length) {
      container.appendChild(el('div', 'px-3 py-2 text-xs text-muted-foreground', '该包暂无工具'));
      return;
    }
    list.forEach((t) => container.appendChild(makeToolRow(t)));
  }

  /** 未归类工具（不属于任何包）——单独一区，否则它们在设置页里无处可见 */
  function renderUngroupedTools() {
    const box = $('#ungrouped-tools');
    if (!box) return;
    const card = box.closest('.settings-card');
    const list = toolsCache.filter((t) => !(t.bundles || []).length);
    if (!list.length) { if (card) card.style.display = 'none'; return; }
    if (card) card.style.display = '';
    box.innerHTML = '';
    list.forEach((t) => box.appendChild(makeToolRow(t)));
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
    /* 方案 C：全局搜索/来源筛选已随「工具列表」卡一并移除 */
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
  /** 设置页 tab → panel 的 **JS 强制互斥**（兜底）。
   *  互斥显隐原本全靠 index.html 里手写的 CSS 长链（每个新 tab 要在 N 条隐藏
   *  规则里各加一行）—— 2026-10-24 语音 tab 就漏了 panel-context 那条，切走后
   *  语音合成卡残留在其它 tab 末尾。现在切 tab 时由 JS 显式接管 panel 显隐
   *  （inline style 特异性最高，覆盖任何 CSS 遗漏/时序），CSS 规则降级为
   *  无 JS 时的回退。新增 tab 不再需要维护隐藏链。 */
  /** 设置页 tab → panel 显隐与 label 高亮的**唯一驱动**。
   *  此前是 index.html 里两套人工维护的 CSS 长链（每加一个 tab 要改 15+ 行，
   *  语音 tab 就漏了 panel-context 的隐藏链，切走后内容残留到其它 tab 末尾），
   *  现已删除 —— 长链按「panel-<name> / label[for=tab-<name>]」命名约定收敛为
   *  这里的单点逻辑；CSS 只保留一条 .is-active 高亮规则和 .settings-panel 初始
   *  隐藏（无 JS 时不闪烁）。新增 tab 零 CSS 维护。 */
  function applySettingsTab(radio) {
    const target = 'panel-' + radio.id.replace(/^tab-/, '');
    $$('.settings-panel').forEach((p) => {
      p.style.display = p.id === target ? 'flex' : 'none';
    });
    $$('.settings-tab').forEach((l) => {
      l.classList.toggle('is-active', l.getAttribute('for') === radio.id);
    });
    // 每次切 tab 重置滚动位置（长 panel 切短 panel 时避免"内容看起来在下面"）
    const scroller = $('.settings-scroll');
    if (scroller) scroller.scrollTop = 0;
    // 分区数据加载钩子（切到某 tab 时刷新该分区的动态状态）
    if (radio.id === 'tab-voice') { void mountPluginCards('settings.voice'); void loadVoiceSettings(); void loadTtsSettings(); }
  }

  function bindSettingsPanelSwitch() {
    const radios = $$('input[name="settings-tab"]');
    radios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked) applySettingsTab(radio);
      });
    });
    // 初始同步：按页面加载时的 checked radio 应用一次（恢复上次的 tab）
    const initial = radios.find((r) => r.checked) || radios[0];
    if (initial) applySettingsTab(initial);
  }

  // ════════════════════════════════════════════════════════════
  // 并行会话标签（chat 视图顶部）
  // ════════════════════════════════════════════════════════════
  // 一条标签 = 一条会话 = 一条独立 /ui WS（独立 UI 协议会话 → 独立 AgentLoop）。
  //   · primary：本页自己的连接，会话随侧栏 / session.switch 变化（恒在首位，不可关）；
  //   · frame：embed iframe，绑定固定会话，非活跃时只是隐藏，任务照常继续跑。
  // 会话互斥由后端 session-claims 强制（同一会话第二条连接会被拒绝），
  // 前端的去重只是提前反馈，不构成唯一防线。
  const TAB_MAX_FRAMES = 6;    // 每条 frame 标签都是一整页 + 一条 AgentLoop，别开成无底洞

  /** embed iframe → 父页（同源 postMessage；非 embed / 顶层窗口时 no-op） */
  function wsPostToParent(msg) {
    if (!embedMode || window.parent === window) return;
    try { window.parent.postMessage(msg, location.origin); } catch (e) { /* 父页已卸载 */ }
  }

  /** 会话 id 归一化比较：会话目录可能以 basename 形式出现 */
  function sameSession(a, b) {
    if (!a || !b) return false;
    const base = (x) => String(x).split(/[\\/]/).pop();
    return a === b || base(a) === base(b);
  }

  /**
   * 标签当前绑定的会话 id。
   *
   * 2026-10-27（C 方案）：**不再有 primary 跟随 currentSessionId 的特例**。
   * 所有标签（含原来那条 primary）的会话都写在自己的 t.sessionId 上。
   * currentSessionId 只保留"本页连接绑定的会话"这一层后端语义（ui.connected 给的），
   * 不再参与标签渲染 —— 否则关掉/切换标签时会读到过期的值。
   */
  function tabSessionId(t) {
    return t.sessionId;
  }

  /** 标签标题：优先会话列表里的真实标题，否则保留占位 */
  function tabTitleFor(sessionId, fallback) {
    if (!sessionId) return fallback || '新会话';
    const hit = sidebarRecentCache.find((s) => s.id === sessionId);
    return hit ? recentSessionTitle(hit) : (fallback || '新会话');
  }

  /** 这条会话已经在哪个标签里（含 primary） */
  function tabForSession(sessionId) {
    if (!sessionId) return null;
    return tabs.find((t) => sameSession(tabSessionId(t), sessionId)) || null;
  }

  /**
   * 「去看另一条会话」的唯一落点：**总是开标签**，不再区分 primary 忙不忙。
   *
   * 2026-10-27 重做（孑遗：「一个 ui 只能连一个会话，改过了但不尽人意」）：
   * 旧版只在 primary 运行时才另开标签，其他情况仍然 session.switch 复用本页连接。
   * 这导致"多会话并行"成了例外路径而不是常态 —— 用户想同时开三个会话，
   * 得先让一个跑起来才能开第二个，交互逻辑是反的。
   *
   * 新语义：**一条会话 = 一个标签 = 一条 WS = 一个独立 AgentLoop**，地位完全平等。
   * 点侧栏会话 ⇒ 已开就切过去，没开就新开标签；本页 primary 的会话不会被顶掉。
   *
   * 为什么不能对运行中的 primary 发 session.switch（保留的历史教训）：
   * `loop.switchSession()` 只登记 pendingSessionDir，真正换目录发生在**下一轮边界**
   * 的 applyPendingSessionSwitch（loop.ts）。切走后当前回合继续跑，但后续写入已
   * 指向别的会话目录；前端 clearChat()+loadHistory() 又把进行中的流式视图清空
   * ⇒ 用户看到「渲染停了，刷新才更新」。
   *
   * @returns 目标标签（可能因达上限为 null）；调用方不要再 switch / 重拉历史
   */
  function openSessionInTab(sid, message) {
    // sid 为空 ⇒ 开**空会话**（2026-10-27 孑遗定的模型）：
    // 标签建一条**不带 session 参数**的连接，后端自铸 id + lazySession:true
    // ⇒ 只登记、不建目录；用户首次输入时 loop.materializeSessionIfNeeded() 才落盘。
    // 所以"新建"不会在磁盘上留下空壳会话。
    //
    // 为什么前端不能先 session.create 拿 id 再开标签：
    //   `?session=<id>` 建连要过 existsSync 校验，而 lazy 会话没有目录、
    //   也不在 session.list 里 ⇒ 必然 SESSION_NOT_FOUND。
    //   会话 id 的真源只能是后端在 WS 握手时铸的那个，iframe 经
    //   `hyacinth:pane-ready` 回传给父页（见 handleTabMessage）。
    if (sid) {
      const existing = tabForSession(sid);
      if (existing) {
        goTo('#/chat');
        activateTab(existing.id);
        return existing;
      }
    }
    const tab = createFrameTab(sid || null);
    if (tab) {
      goTo('#/chat');
      if (message) appendMsg('system', message);
    }
    return tab;
  }

  function renderTabs() {
    const list = $('#session-tabs-list');
    if (!list || embedMode) return;
    // 标签条显隐：**空时隐藏**，有标签才占那一行。
    //
    // 2026-10-27（A2 之后再修）：上一版写成"常显"，理由是要让人看到新建按钮。
    // 但 A2 之后页面初始就是 0 个标签，于是首屏多出一条只有左边一个 + 的空白横条
    // （实测截图可见）—— 既浪费 30px 视觉重量，又让人以为"这里本该有东西却坏了"。
    // 正确做法：没有标签就整条不占位；新建入口在侧栏「新会话」按钮与「+」两处都有，
    // 空态下用户仍能开新会话，不依赖这条空横条。
    const bar = $('#session-tabs');
    if (bar) bar.hidden = tabs.length === 0;
    list.innerHTML = '';
    tabs.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'session-tab'
        + (t.id === activeTabId ? ' is-active' : '')
        + (t.running ? ' is-running' : '')
        + (t.error ? ' is-error' : '');
      btn.dataset.tabId = t.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', t.id === activeTabId ? 'true' : 'false');
      btn.title = t.error || tabSessionId(t) || '新会话';

      const dot = document.createElement('span');
      dot.className = 'session-tab-dot';
      const title = document.createElement('span');
      title.className = 'session-tab-title';
      title.textContent = t.title || '新会话';
      btn.appendChild(dot);
      btn.appendChild(title);

      // 2026-10-27：所有标签都有关闭键（旧版只有 frame 有，primary 永远关不掉）。
      // 关闭键用 span 而不是 button：标签本身已是 button，嵌套 button 是非法 HTML
      const close = document.createElement('span');
      close.className = 'session-tab-close';
      close.dataset.tabClose = t.id;
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', '关闭标签');
      close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      btn.appendChild(close);
      list.appendChild(btn);
    });
    // 单一出口：标签重画后顶栏标题必然与"当前可见标签"一致，
    // 不依赖每个调用点各记一次同步（此前 pane-ready/status 就漏了，标题会停在旧值）。
    syncTopbarTitle();
  }

  function activateTab(tabId) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    activeTabId = tab.id;
    if (tab.sessionId) { try { localStorage.setItem('hyacinth.lastSession', tab.sessionId); } catch (e) { /* ignore */ } }
    tabs.forEach((t) => { if (t.pane) t.pane.hidden = t.id !== activeTabId; });
    renderTabs();           // 内部同步顶栏标题
    renderSidebarRecent();  // 侧栏高亮同步到当前可见标签
    // 切到某个标签 = 看它的最新进度：切走期间可能积了很多输出，不该停在离开时的位置。
    // 2026-10-27（C 方案）：不再只对 primary 做 —— 每个标签都是独立会话，地位平等。
    // frame 标签由 iframe 自己管滚动，这里只管本页原生 pane。
    if (!tab.frame) scrollChat();
  }

  /** 顶栏「当前会话」= 当前可见标签的标题 */
  function syncTopbarTitle() {
    const active = tabs.find((t) => t.id === activeTabId);
    const el = $('#session-title');
    if (active && el) el.textContent = active.title || '新会话';
  }

    /** frame 标签 iframe 地址（token 透传：iframe 内的 WS 握手同样需要钥匙） */
  function frameUrl(sessionId) {
    const p = new URLSearchParams();
    p.set('embed', '1');
    if (sessionId) p.set('session', sessionId);
    const token = URL_PARAMS.get('token');
    if (token) p.set('token', token);
    return '/index.html?' + p.toString();
  }

  /** 开一个新标签。sessionId 为空 ⇒ 空会话（首条消息才物化） */
  function createFrameTab(sessionId) {
    if (embedMode) return null;
    const panes = $('#chat-panes');
    if (!panes) return null;
    if (tabs.filter((t) => t.kind === 'frame').length >= TAB_MAX_FRAMES) {
      appendMsg('system', `最多同时打开 ${TAB_MAX_FRAMES} 个并行标签`);
      return null;
    }

    const id = 'tab-' + (++tabSeq);
    // 新会话还没标题（懒登记，首条消息才物化）⇒ 用开标签的时刻当占位名，
    // 否则并行开两个新标签会得到两个一模一样的「新会话」，切分不清。
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const placeholder = `新会话 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const pane = document.createElement('div');
    pane.className = 'chat-pane';
    pane.dataset.tabPane = id;
    pane.hidden = true;
    const frame = document.createElement('iframe');
    frame.className = 'chat-pane-frame';
    frame.title = '并行会话';
    frame.src = frameUrl(sessionId);
    pane.appendChild(frame);
    panes.appendChild(pane);

    const tab = {
      id,
      kind: 'frame',
      sessionId: sessionId || null,
      title: sessionId ? tabTitleFor(sessionId) : placeholder,
      running: false,
      error: '',
      pane,
      frame,
    };
    tabs.push(tab);
    activateTab(id);
    return tab;
  }

  function closeTab(tabId) {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const tab = tabs[idx];
    // 2026-10-27（A2）：**任何标签都能真关**，最后一个也不例外。
    // 关标签 = iframe 导航到 about:blank ⇒ 文档卸载 ⇒ WS 断开 ⇒ 后端
    // UiProtocolSession.close() 释放会话占用并置 loop=null（loop 随之可回收）。
    // 关完没有标签时，界面回到空态（#chat-wrapper 里的空提示），
    // 用户从侧栏点会话或点「+」新建即可 —— 不预置任何空壳标签。
    tabs.splice(idx, 1);
    // 先导航走再删：文档卸载会立即断开这条 WS，后端随即释放会话占用
    if (tab.frame) {
      try { tab.frame.src = 'about:blank'; } catch (e) { /* ignore */ }
    }
    if (tab.pane) tab.pane.remove();
    if (activeTabId === tabId) {
      // 关的是当前标签 ⇒ 切到相邻的（优先左边，没有就右边）
      const next = tabs[Math.max(0, idx - 1)] || tabs[0];
      if (next) {
        activateTab(next.id);   // 内部会 renderTabs + renderSidebarRecent
      } else {
        // ⚠️ 关掉的是**最后一条**：tabs 已空，没有可切换的目标。
        // 必须显式清 activeTabId 并重绘，否则标签按钮会留在标签栏上
        // 变成一个点了没反应的死键（2026-10-27 MCP 实测发现）。
        activeTabId = null;
        renderTabs();
        renderSidebarRecent();
      }
    } else {
      renderTabs();
      renderSidebarRecent();   // 关掉的标签可能正带着「运行中」标记
    }
  }


  /** 打开一条已有会话：已在某个标签里 ⇒ 切过去；否则新开一个 frame 标签 */
  function openSessionTab(sessionId) {
    if (!sessionId) return null;
    const existing = tabForSession(sessionId);
    if (existing) { activateTab(existing.id); return existing; }
    return createFrameTab(sessionId);
  }

  /** iframe → 父页：就绪 / 运行状态 / 失败原因（同源校验） */
  function handleTabMessage(ev) {
    if (ev.origin !== location.origin) return;
    const tab = tabs.find((t) => t.frame && t.frame.contentWindow === ev.source);
    if (!tab) return;
    const data = ev.data || {};
    if (data.type === 'hyacinth:pane-ready' && data.sessionId) {
      // 去重兜底：同一会话被两个标签认领（正常会被后端占用表拦住）
      const dup = tabs.find((t) => t !== tab && sameSession(tabSessionId(t), data.sessionId));
      if (dup) {
        tab.error = '该会话已在其他标签打开';
        renderTabs();
        return;
      }
      tab.sessionId = data.sessionId;
      try { localStorage.setItem('hyacinth.lastSession', data.sessionId); } catch (e) { /* ignore */ }
      tab.title = tabTitleFor(data.sessionId, tab.title);
      tab.error = '';
      renderTabs();
      // 标签刚拿到会话 id ⇒ 侧栏高亮/运行点要立刻跟上（顶栏由 renderTabs 同步）
      renderSidebarRecent();
    } else if (data.type === 'hyacinth:pane-status') {
      tab.running = !!data.running;
      tab.error = '';
      if (data.sessionId) tab.sessionId = data.sessionId;
      renderTabs();
      renderSidebarRecent();
      // 回合开始：新会话可能刚物化 ⇒ 拉一次列表让它带运行点出现在侧栏；
      // 回合结束：updatedAt 变了 ⇒ 刷新相对时间，并把占位标题换成真实标题。
      const inCache = sidebarRecentCache.some((s) => sameSession(s.id, tab.sessionId));
      if (!data.running || !inCache) void loadSidebarRecent().then(() => syncTabTitles());
    } else if (data.type === 'hyacinth:pane-error') {
      tab.error = data.message || '连接失败';
      tab.running = false;
      renderTabs();
      renderSidebarRecent();
    } else if (data.type === 'hyacinth:ctx') {
      tab.ctx = Object.assign({}, tab.ctx || {}, data.snap || {}, (data.tokensUsed != null ? { tokensUsed: data.tokensUsed } : {}), (data.maxContextTokens != null ? { maxContextTokens: data.maxContextTokens } : {}));
      if (tab.id === activeTabId) renderHeaderCtx(tab.ctx);
    }
  }

  /** 会话列表更新后，把 frame 标签的占位标题换成真实标题 */
  function syncTabTitles() {
    let changed = false;
    tabs.forEach((t) => {
      if (t.kind !== 'frame' || !t.sessionId) return;
      const next = tabTitleFor(t.sessionId, t.title);
      if (next && next !== t.title) { t.title = next; changed = true; }
    });
    if (changed) renderTabs();   // 顶栏标题由 renderTabs 同步
  }

  function bindSessionTabs() {
    if (embedMode) return;   // iframe 内不显示标签条
    // 2026-10-27（A2）：**标签从空开始**，页面不再预置"本页自己那格"。
    //
    // 为什么彻底去掉 native pane：
    //   旧模型里第一条标签复用本页的 WS + 原生 DOM，其余标签是 iframe ⇒ 两套语义。
    //   而 WS 的 sessionId 是**握手时后端铸的**（http-webhook.ts），前端改不了指向，
    //   于是"这条标签换会话"只能靠整页重连 —— 这就是之前所有别扭的根源。
    //   A2 把所有会话统一成 iframe：一条标签 = 一个 iframe = 一条 WS = 一个 AgentLoop，
    //   关标签即 frame.src='about:blank' ⇒ 断 WS ⇒ 后端 close() 释放 loop 与占用。
    //
    // 空状态（没有任何标签）由 #chat-wrapper 里的空提示承载，用户从侧栏点会话或点「+」新建。
    tabs = [];
    activeTabId = null;

    const addBtn = $('#tab-new-btn');
    if (addBtn) addBtn.addEventListener('click', () => createFrameTab(null));

    const list = $('#session-tabs-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const close = e.target.closest('[data-tab-close]');
        if (close) { closeTab(close.dataset.tabClose); return; }
        const btn = e.target.closest('[data-tab-id]');
        if (btn) activateTab(btn.dataset.tabId);
      });
    }
    window.addEventListener('message', handleTabMessage);
    renderTabs();
  }

  function bindUI() {
    bindToolsMCP();
    bindSessionTabs();
    bindSettingsPanelSwitch();
    // 侧栏搜索：输入即过滤本地缓存（列表已在内存里，不打后端）
    const sbSearch = $('#session-search');
    if (sbSearch) {
      sbSearch.addEventListener('input', () => renderSidebarRecent());
      sbSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { sbSearch.value = ''; renderSidebarRecent(); sbSearch.blur(); }
      });
    }

    // 新会话（侧栏顶部按钮，id="session-new-btn"）
    // 必须 create 之后紧跟 switch：session.create 只建目录，loop 仍指向旧会话，
    // 不切的话"新会话"点完，下一句话还是写进上一个会话里（与 #/sessions 的新建同款）。
    // 例外：本页正在跑一轮对话时不 switch（会打断当前回合），改为另开标签（见下）。
    const newBtn = $('#session-new-btn');
    if (newBtn) {
      newBtn.onclick = () => {
        if (!connected) return;
        // 空会话 = 不带 session 参数的连接（后端自铸 id + lazySession，首条消息才落盘）
        openSessionInTab(null, '已新建空会话（发出第一条消息后才会保存）');
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
      // 自动增高：单行起步，随内容长到 180px 再滚（CSS 里的 max-height 是硬上限）。
      // 之前只有陪伴视图的输入框做了这件事，主输入框一直是固定单行 —— 写多段需求时只能看到一行。
      const autoGrow = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      };
      input.addEventListener('input', autoGrow);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          // 显式组合键：多行输入时也能直接发，不必切到行尾按 Enter
          ev.preventDefault();
          sendChat();
          return;
        }
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

    // 图片附件：点选 / 粘贴 / 拖入（后端 channelImages 早已支持，此前前端是空壳）
    bindAttachments();
    bindCodeCopy();
    bindPreviewDock();
    bindModeMenu();
    bindViewMenu();
    bindModelPicker();
    bindSttButton();
    bindModelsRootOnce();
    // TTS/播报两张卡由 say-voice 插件贡献：进语音 tab 时 mountPluginCards 动态挂载并绑定
    bindGlobalInteractions();

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
        // 方案A：陪伴入口（品牌/companion-entry，href="#/companion"）⇒ 开一个独立陪伴会话标签，
        // 不再 goTo 外层 companion 视图（外层 loop 不是 companion，那视图是空的）。
        if (href === '#/companion' && !embedMode) {
          e.preventDefault();
          toggleCompanion();
          setNavDrawer(false);
          return;
        }
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
    // （appendMsg / clearChat / renderHistoryMsg / loadHistory）✓
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
  // embed 标签额外带 session：后端据此绑定已有会话并做占用校验；
  // 不带 = 旧行为（每条连接铸新 id，首条消息才物化）。
  const wsQuery = new URLSearchParams();
  const wsToken = URL_PARAMS.get('token');
  if (wsToken) wsQuery.set('token', wsToken);
  if (embedMode && embedSessionParam) wsQuery.set('session', embedSessionParam);
  const wsUrl = `${wsProto}://${host}:${port}/ui${wsQuery.toString() ? '?' + wsQuery.toString() : ''}`;

  const client = new ProtocolClient(wsUrl, {
    onOpen: () => {
      // 预览栏的启动期 RPC 排队在这（bindPreviewDock 早于 client 创建执行）
      pvResolveReady();
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
  initCodeThemeFromCache();
  renderCodeThemes();
  // 主题目录异步加载：拿不到就用手上的兜底，换肤本身不依赖它
  loadThemeCatalog();
  // ⚠️ 这里**故意不再**用 localStorage 缓存抢先跳到 #/companion（2026-10-16 移除）：
  //   那份缓存只在"本页写、本页读"时自洽；一旦配置经**别的渠道**变更
  //   （TUI `/default-mode`、直接改 config.json、另一个窗口），缓存就陈旧
  //   ⇒ 页面按陈旧值跳进陪伴视图，而配置与后端其实都是 normal。
  //   实测复现：config=normal、后端 companion.get={active:false}，页面 hash 却是 `#/companion`。
  //   现在「启动默认模式」的真源 = **后端配置**：ui.connected 后读
  //   `config.get startup.defaultMode` 再决定是否跳转（见 handleEvent 的 ui.connected 分支）。
  //   代价：配置为陪伴时，首屏可能有一瞬 chat 再切到陪伴 —— 用"正确"换掉"不闪" ✓

  // ════════════════════════════════════════════════════════════
  // 结构修正：把散落在 #app-shell 下的视图收进 #hyacinth-main
  // ----------------------------------------------------------------
  // 现象（2026-10-27 实测）：切到「设置 / 模型选择」等视图时，左上角侧栏与
  //   设置页叠在一起，主内容区整块消失 —— 实测 .body-area 高度 = 0。
  // 根因：源码里 6 个 <section data-view="…">（model/sessions/schedule/
  //   plugins/skills/settings）**被浏览器解析成了 #app-shell 的直接子元素**，
  //   与 .body-area 平级。它们带 `h-full`（height:100%）⇒ 相对 #app-shell
  //   撑满 824px，把 flex-1 的 .body-area 挤成 0；同时它们从 x=0 铺开，
  //   与侧栏（0..280）直接重叠。chat 视图在源码里却是嵌在 <main> 内的
  //   ⇒ 同一份 HTML 混了两套布局范式。
  // 修法：运行时挪进 #hyacinth-main。h-full 于是相对 main 计算，.body-area
  //   保回原高度，侧栏重新占位。实测 .body-area 851x0 → 851x776 ✓
  // ⚠️ 不要"把源码里的 section 挪进 main"来修：浏览器解析结果与源码位置
  //    不一致，说明上游有嵌套错误，挪源码不一定生效（已实测）。
  // ⚠️ 必须在 bindUI()/navigate() 之前执行，否则第一次导航拿到的还是坏布局。
  // ════════════════════════════════════════════════════════════
  (function normalizeViewSections() {
    const shell = document.getElementById('app-shell');
    const main = document.getElementById('hyacinth-main');
    if (!shell || !main) {
      console.warn('[layout] app-shell / hyacinth-main 缺失，跳过结构修正');
      return;
    }
    const stray = [...shell.children].filter(
      (el) => el.tagName === 'SECTION' && el.classList.contains('view-section'),
    );
    if (!stray.length) return;
    for (const sec of stray) main.appendChild(sec);
    console.info('[layout] 已收进 main 的视图:', stray.map((s2) => s2.dataset.view).join(', '));
  })();

  // ════════════════════════════════════════════════════════════
  // 「模型选择」并入「设置」（2026-10-27 用户要求：配置不该分两处）
  // ----------------------------------------------------------------
  // 现状：侧栏有独立「模型选择」视图，设置页又有「模型」tab；
  //   而那个 tab 里**只有生成参数**（温度/TopP…），真正的模型管理
  //   （当前模型 / 在线提供商 / 推理强度 / 本地模型 / 模型通道）
  //   都在独立视图的 .model-panel 里 ⇒ 用户要改模型得跑两个地方。
  // 做法：把 .model-panel 整块搬进 #panel-model（tab 内容区）。
  //   全部逻辑按 id 取元素 ⇒ 搬家后 loadModel() 等一行不用改。
  // ════════════════════════════════════════════════════════════
  (function mergeModelPanelIntoSettings() {
    const target = document.getElementById('panel-model');
    const src = document.querySelector('section[data-view="model"] .model-panel');
    if (!target || !src) {
      console.warn('[layout] 模型面板合并跳过（缺 panel-model 或 .model-panel）');
      return;
    }
    src.classList.remove('p-6', 'md:p-8');
    /* 去掉与 tab 标题重复的大标题块（「模型选择」+ 说明） */
    const h1 = src.querySelector('h1');
    if (h1) h1.parentElement?.remove();
    target.insertBefore(src, target.firstChild);
    console.info('[layout] 模型管理已并入设置页「模型」tab');

    /* ── 子页签：把合并后 3060px 的单一滚动拆成 4 组 ────────────────
     * 为什么拆：并入后 = 当前启用 + 16 张提供商卡 + 推理 + 本地 + 通道(25 控件)
     *   + 生成参数 + 模型行为，全部堆在一个 tab 里要滚 3000+px。
     * 做法：分组只打 data-msub 标记，切换只改 display，**不动 DOM 结构**
     *   ⇒ loadModel() 里所有 $('#model-xxx') 取元素不受影响。
     * ⚠️ 必须显式隐藏 .model-panel 包装层：它在「生成参数」组激活时若仍
     *    display:block，会作为空 flex 子项产生 20px 的 gap 空隙。 */
    const secByHeading = (id) => src.querySelector(`[aria-labelledby="${id}"]`);
    const tagGroup = (key, els) => {
      for (const el of els) if (el) el.dataset.msub = key;
    };
    tagGroup('providers', [secByHeading('active-provider-heading'), secByHeading('online-providers-heading')]);
    tagGroup('reasoning', [secByHeading('reasoning-heading'), secByHeading('local-model-heading')]);
    tagGroup('channels', [secByHeading('channels-heading')]);
    tagGroup('params', [...target.querySelectorAll(':scope > .settings-card')]);

    const SUBTABS = [
      ['providers', '提供商'],
      ['reasoning', '推理与本地'],
      ['channels', '通道'],
      ['params', '生成参数'],
    ];
    const bar = document.createElement('div');
    bar.className = 'model-subtabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '模型子页');
    for (const [key, label] of SUBTABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-subtab';
      btn.dataset.msubtab = key;
      btn.textContent = label;
      bar.appendChild(btn);
    }
    target.insertBefore(bar, target.firstChild);

    const applySub = (key) => {
      for (const el of target.querySelectorAll('[data-msub]')) {
        el.style.display = el.dataset.msub === key ? '' : 'none';
      }
      /* 包装层只在「提供商/推理/通道」三组时有内容；「生成参数」组全是
         #panel-model 的直接 settings-card ⇒ 包装层必须整个收起，否则留空隙 */
      src.style.display = key === 'params' ? 'none' : '';
      bar.querySelectorAll('.model-subtab').forEach((b) => {
        const on = b.dataset.msubtab === key;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    };
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.model-subtab');
      if (btn) applySub(btn.dataset.msubtab);
    });
    applySub('providers');
    console.info('[layout] 模型 tab 已拆为 4 个子页');
  })();

  // ════════════════════════════════════════════════════════════
  // 切到「模型」tab 时拉一次模型数据
  // ----------------------------------------------------------------
  // loadModel() 原来挂在"进入 model 视图"（applyView）上。并入设置后，
  //   在设置页内部切 tab 走的是 radio 的 change，**不经过路由** ⇒ 不触发。
  //   实测症状：切到「模型」tab 后当前模型显示「—」、提供商只剩一句
  //   「连接后端后加载提供商…」、模型通道 0 行。
  // ⚠️ 只绑一次：早先这里重复绑了两份（同一逻辑写了两遍），已合并。
  // ════════════════════════════════════════════════════════════
  (function bindModelTabReload() {
    const radio = document.getElementById('tab-model');
    if (!radio) {
      console.warn('[model] 找不到 tab-model，模型 tab 重载监听未绑定');
      return;
    }
    radio.addEventListener('change', () => {
      /* 诊断日志：定位"切了 tab 但没数据"时用它区分是回调没进还是连接未就绪 */
      console.info('[model] tab change → checked=', radio.checked, 'connected=', connected);
      if (radio.checked && connected) loadModel();
    });
  })();

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
    // 预览栏对外入口：协议层/调试可直接定位到某个工作区文件
    preview: { open: pvSetOpen, reveal: pvRevealPath },
  };
})();
