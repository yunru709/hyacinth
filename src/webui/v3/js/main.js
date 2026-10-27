/* ============================================================================
   Hyacinth WebUI v3 — 应用入口

   与 v1/v2 的差别：
     没有侧栏、没有常驻顶栏。会话切换走「左缘色标」或「⌘K 浮层」，
     低频页走「全屏覆盖」。

   底层契约完全沿用（不动后端一行）：
     · 每条会话 = 一个 iframe = 一条 WS = 一个 AgentLoop
     · 非活跃会话只 hidden ⇒ 任务继续跑
     · 关标签 = frame 导航走 ⇒ 断 WS ⇒ 后端释放 loop
     · 空会话 = 不带 session 的 iframe ⇒ 后端 lazy 铸 id，首条消息才落盘
   ========================================================================== */

/* ═══ 协议客户端 ═════════════════════════════════════════════════════════ */
class Client {
  constructor() {
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
    this.connected = false;
    this.closedByUser = false;
    this.delay = 800;
    this.handlers = {};
  }

  connect() {
    if (this.closedByUser) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = new URLSearchParams(location.search).get('token');
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ui${qs}`);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.delay = 800;
      this.handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.kind === 'response') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(m.error || { message: 'error' });
      } else if (m.kind === 'event') {
        this.handlers.onEvent?.(m.type, m.payload);
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.handlers.onClose?.();
      if (this.closedByUser) return;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 10000);
    };
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
        reject({ message: '未连接' });
        return;
      }
      const id = 'r' + (++this.seq);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }
}

const client = new Client();

/* ═══ 状态 ═══════════════════════════════════════════════════════════════ */
const state = {
  tabs: [],            // { id, sessionId, title, running, pane, frame, color }
  activeTab: null,
  running: false,
  streamEl: null,
  assistantEl: null,
  sessions: [],
};

const STRIPE_COLORS = ['#8b7dff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8', '#fb923c'];

/* ═══ DOM ════════════════════════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

/* ═══ 主题 × 配色 ════════════════════════════════════════════════════════
   两个正交维度，各写一个 html 属性：
     data-theme="void|flow|focus|console|reading"   → 结构（themes.css）
     data-palette="night|day|sepia|mono|forest"     → 颜色（palettes.css）

   为什么不分两次写 CSS 变量：变量的"名字空间"天然不重叠
   （结构用 --stream-* / --composer-* / --side-*，颜色用 --bg / --fg / --accent），
   所以浏览器会把两套值同时应用，天然正交 —— 不需要 JS 做任何合并。

   性能：切换只改两个 DOM 属性 ⇒ 一次样式重算，不重建 DOM、不 reflow 整页。
   ══════════════════════════════════════════════════════════════════════ */
const THEMES = ['void', 'flow', 'focus', 'console', 'reading'];
const PALETTES = ['night', 'day', 'sepia', 'mono', 'forest'];

const THEME_LABELS = {
  void: '极简', flow: '流体', focus: '专注', console: '终端', reading: '阅读',
};
const PALETTE_LABELS = {
  night: '夜', day: '日', sepia: '褐', mono: '单色', forest: '林',
};

/** 只切结构。不碰颜色 —— 颜色由 applyPalette 独立负责。 */
/** 结构 flag：主题通过它改变**布局**，不只是颜色。
 *  写到 #stage 上，由 shell.css 的 [data-*] 选择器消费。
 *  ⚠️ 这段一度被我删掉，导致 console/focus 等主题只换了色、布局没变。 */
const THEME_FLAGS = {
  void:    { align: 'center', welcome: 'center', side: 'left',  composer: 'underline', send: 'text', mark: 'bar',   user: 'line',  hint: 'focus',  grid: 'off' },
  flow:    { align: 'center', welcome: 'center', side: 'left',  composer: 'card',      send: 'icon', mark: 'pill',  user: 'line',  hint: 'focus',  grid: 'off' },
  focus:   { align: 'left',   welcome: 'left',   side: 'top',   composer: 'bar',       send: 'icon', mark: 'tab',   user: 'line',  hint: 'always', grid: 'off' },
  console: { align: 'left',   welcome: 'left',   side: 'left',  composer: 'cmd',       send: 'text', mark: 'block', user: 'line',  hint: 'always', grid: 'on' },
  reading: { align: 'left',   welcome: 'left',   side: 'right', composer: 'line',      send: 'icon', mark: 'dot',   user: 'quote', hint: 'focus',  grid: 'off' },
};

function applyFlags(name) {
  const stage = document.getElementById('stage');
  const stripes = document.getElementById('stripes');
  const f = THEME_FLAGS[name] || THEME_FLAGS.void;
  if (stage) {
    stage.dataset.align = f.align;
    stage.dataset.welcome = f.welcome;
    stage.dataset.side = f.side;
    stage.dataset.composer = f.composer;
    stage.dataset.send = f.send;
    stage.dataset.user = f.user;
    stage.dataset.hint = f.hint;
    stage.dataset.grid = f.grid;
  }
  if (stripes) stripes.dataset.mark = f.mark;
}

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'void';
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', name);
  applyFlags(name);
  localStorage.setItem('h3.theme', name);
  flashLabel(`${THEME_LABELS[name]} · ${PALETTE_LABELS[root.getAttribute('data-palette') || 'night']}`);
  setTimeout(() => root.classList.remove('theme-switching'), 320);
  syncThemeMenu();
}

/** 只切颜色。不碰结构。 */
function applyPalette(name) {
  if (!PALETTES.includes(name)) name = 'night';
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-palette', name);
  localStorage.setItem('h3.palette', name);
  flashLabel(`${THEME_LABELS[root.getAttribute('data-theme') || 'void']} · ${PALETTE_LABELS[name]}`);
  setTimeout(() => root.classList.remove('theme-switching'), 320);
  syncThemeMenu();
}

/** 状态线上的当前组合标签：切换后短暂亮起，随后变淡（不当调试信息常显）。 */
function flashLabel(text) {
  if (text) $('theme-label').textContent = text;
  $('theme-label').style.opacity = '1';
  clearTimeout(window.__tlTimer);
  window.__tlTimer = setTimeout(() => { $('theme-label').style.opacity = '0.35'; }, 1600);
}

function initTheme() {
  // URL 参数优先于 localStorage：截图 / 分享链接需要能直接指定组合，
  // 否则 headless 每次都是全新 profile，截出来的永远是默认主题。
  const q = new URLSearchParams(location.search);
  const savedT = q.get('theme') || localStorage.getItem('h3.theme');
  const savedP = q.get('palette') || localStorage.getItem('h3.palette');
  applyTheme(THEMES.includes(savedT) ? savedT : 'void');
  applyPalette(PALETTES.includes(savedP) ? savedP : 'night');
  $('theme-label').style.opacity = '0.35';

  // 状态线上的主题按钮：直接打开「外观」面板
  $('btn-theme').addEventListener('click', () => openPage('look'));
}

/** 外观面板里两组按钮的高亮同步（面板可能没打开，静默跳过）。 */
function syncThemeMenu() {
  const root = document.documentElement;
  const t = root.getAttribute('data-theme');
  const p = root.getAttribute('data-palette');
  for (const b of document.querySelectorAll('[data-theme-pick]')) {
    b.classList.toggle('is-active', b.dataset.themePick === t);
  }
  for (const b of document.querySelectorAll('[data-palette-pick]')) {
    b.classList.toggle('is-active', b.dataset.palettePick === p);
  }
}

/* ═══ 对话：消息与输入 ═══════════════════════════════════════════════════ */
function autosize() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  $('btn-send').disabled = !el.value.trim() || state.running;
}

function appendMsg(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg--${role}`;
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.appendChild(body);
  $('stream-inner').appendChild(wrap);
  state.streamEl = $('stream');
  scrollDown();
  return body;
}

function scrollDown() {
  const s = $('stream');
  if (s.scrollHeight - s.scrollTop - s.clientHeight < 140) s.scrollTop = s.scrollHeight;
}

function setRunning(on) {
  state.running = on;
  $('btn-send').hidden = on;
  $('btn-stop').hidden = !on;
  $('btn-send').disabled = on || !$('input').value.trim();
  const dot = $('conn-dot');
  dot.dataset.state = on ? 'busy' : (client.connected ? 'online' : 'offline');
  renderStripes();
}

async function send() {
  const el = $('input');
  const text = el.value.trim();
  if (!text || state.running) return;

  el.value = '';
  autosize();

  $('welcome').hidden = true;
  $('stream').hidden = false;
  appendMsg('user', text);

  setRunning(true);
  try {
    await client.request('message.chat', { text });
  } catch (err) {
    setRunning(false);
    appendMsg('error', err?.message || '发送失败');
  }
}

/* ═══ 会话色标 ═══════════════════════════════════════════════════════════ */
function renderStripes() {
  const list = $('stripe-list');
  list.innerHTML = '';

  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'stripe';
    el.dataset.active = String(t.id === state.activeTab?.id);
    el.style.setProperty('--stripe-color', t.color);

    const mark = document.createElement('div');
    mark.className = 'stripe-mark';

    const body = document.createElement('div');
    body.className = 'stripe-body';

    const title = document.createElement('span');
    title.className = 'stripe-title';
    title.textContent = t.title;

    body.appendChild(title);

    if (t.running) {
      const busy = document.createElement('span');
      busy.className = 'stripe-busy';
      body.appendChild(busy);
    }

    const x = document.createElement('button');
    x.className = 'stripe-x';
    x.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
    body.appendChild(x);

    el.append(mark, body);
    el.addEventListener('click', () => activateTab(t.id));
    list.appendChild(el);
  }

  $('session-count').textContent = String(state.tabs.length);
}

function openTab(sessionId) {
  if (sessionId) {
    const exist = state.tabs.find((t) => t.sessionId === sessionId);
    if (exist) { activateTab(exist.id); return exist; }
  }

  const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.hidden = true;

  const frame = document.createElement('iframe');
  frame.className = 'pane-frame';
  const qs = new URLSearchParams({ embed: '1' });
  if (sessionId) qs.set('session', sessionId);
  frame.src = `/index.html?${qs.toString()}`;
  pane.appendChild(frame);
  $('panes').appendChild(pane);

  const tab = {
    id,
    sessionId: sessionId || null,
    title: sessionId ? sessionId.slice(-8) : '新会话',
    running: false,
    pane,
    frame,
    color: STRIPE_COLORS[state.tabs.length % STRIPE_COLORS.length],
  };
  state.tabs.push(tab);
  activateTab(id);
  return tab;
}

function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  state.activeTab = tab;

  for (const t of state.tabs) t.pane.hidden = t.id !== id;

  // 有活跃标签时，本页自己的会话面隐藏（全部会话都在 iframe 里）
  $('main-surface').hidden = true;
  renderStripes();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];

  try { tab.frame.src = 'about:blank'; } catch { /* ignore */ }
  tab.pane.remove();
  state.tabs.splice(idx, 1);

  if (state.activeTab?.id === id) {
    const next = state.tabs[idx - 1] || state.tabs[idx] || state.tabs[0] || null;
    state.activeTab = null;
    if (next) activateTab(next.id);
    else {
      // 最后一个也关了 ⇒ 回到本页自己的空会话面
      $('main-surface').hidden = false;
      $('welcome').hidden = false;
      $('stream').hidden = true;
    }
  }
  renderStripes();
}

/* ═══ 浮层：会话列表（⌘K）═══════════════════════════════════════════════ */
let paletteOpen = false;

async function openPalette() {
  paletteOpen = true;
  $('palette').hidden = false;
  const input = $('palette-input');
  input.value = '';
  input.focus();

  try {
    const res = await client.request('session.list', {});
    state.sessions = res?.sessions || res || [];
  } catch {
    state.sessions = [];
  }
  renderPalette('');
}

function closePalette() {
  paletteOpen = false;
  $('palette').hidden = true;
}

function renderPalette(filter) {
  const list = $('palette-list');
  list.innerHTML = '';

  const cmds = [
    { title: '新会话', meta: 'Ctrl+N', run: () => { closePalette(); openTab(null); } },
    { title: '设置', meta: '', run: () => { closePalette(); openPage('settings'); } },
    { title: '模型', meta: '', run: () => { closePalette(); openPage('model'); } },
    { title: '技能', meta: '', run: () => { closePalette(); openPage('skills'); } },
  ].filter((c) => !filter || c.title.includes(filter));

  if (cmds.length) {
    const g = document.createElement('div');
    g.className = 'pal-group';
    g.textContent = '命令';
    list.appendChild(g);
    for (const c of cmds) {
      const b = document.createElement('button');
      b.className = 'pal-hit';
      b.innerHTML = `<span class="pal-hit-title">${c.title}</span><span class="pal-hit-meta">${c.meta}</span>`;
      b.addEventListener('click', c.run);
      list.appendChild(b);
    }
  }

  const hits = state.sessions.filter((s) => !filter || (s.title || s.id || '').includes(filter));
  if (hits.length) {
    const g = document.createElement('div');
    g.className = 'pal-group';
    g.textContent = '会话';
    list.appendChild(g);
    for (const s of hits.slice(0, 30)) {
      const b = document.createElement('button');
      b.className = 'pal-hit';
      const title = s.title || s.id;
      const meta = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '';
      b.innerHTML = `<span class="pal-hit-title"></span><span class="pal-hit-meta">${meta}</span>`;
      b.querySelector('.pal-hit-title').textContent = title;
      b.addEventListener('click', () => {
        closePalette();
        openTab(s.id);
      });
      list.appendChild(b);
    }
  }

  if (!list.children.length) {
    const e = document.createElement('div');
    e.className = 'pal-empty';
    e.textContent = filter ? '没有匹配项' : '还没有会话';
    list.appendChild(e);
  }
}

/* ═══ 全屏页 ═════════════════════════════════════════════════════════════ */
const PAGE_NAV = {
  look: [],
  settings: [],
  model: ['通道', '本地模型'],
  skills: [],
};

const PAGE_TITLES = {
  look: '外观',
  settings: '设置',
  model: '模型',
  skills: '技能',
};

async function openPage(name) {
  $('page').hidden = false;
  $('page-title').textContent = PAGE_TITLES[name] || name;

  const nav = $('page-nav');
  nav.innerHTML = '';
  const items = PAGE_NAV[name] || [];
  items.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'page-nav-item' + (i === 0 ? ' is-active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      for (const x of nav.children) x.classList.remove('is-active');
      b.classList.add('is-active');
    });
    nav.appendChild(b);
  });

  const inner = $('page-inner');
  inner.innerHTML = '<div style="color:var(--fg-subtle);font-size:12px">加载中…</div>';

  try {
    if (name === 'look') renderLook(inner);
    else if (name === 'settings') await renderSettings(inner, items[0] || '外观');
    else if (name === 'model') await renderModel(inner);
    else if (name === 'skills') await renderSkills(inner);
  } catch (err) {
    inner.innerHTML = '';
    const e = document.createElement('div');
    e.style.cssText = 'color:var(--err);font-size:12px';
    e.textContent = err.message || '加载失败';
    inner.appendChild(e);
  }
}

/* ═══ 外观页：主题 × 配色（两个独立维度）════════════════════════════════
   主题 = 结构（输入框形态、消息排布、会话栏位置、密度、动效）
   配色 = 颜色
   两者正交，这里给两组独立的按钮，各管各的。 */
function renderLook(inner) {
  inner.innerHTML = '';

  // ── 主题组 ──
  const secT = document.createElement('div');
  secT.className = 'c-section';
  const hT = document.createElement('div');
  hT.className = 'c-section-title';
  hT.textContent = '主题';
  const dT = document.createElement('div');
  dT.className = 'c-section-desc';
  dT.textContent = '决定布局与交互：输入框形态、消息排布、会话栏位置、密度、动效节奏。';
  secT.append(hT, dT);

  const gridT = document.createElement('div');
  gridT.className = 'look-grid';
  for (const t of THEMES) {
    const card = document.createElement('button');
    card.className = 'look-card';
    card.dataset.themePick = t;
    card.type = 'button';

    const name = document.createElement('div');
    name.className = 'look-name';
    name.textContent = THEME_LABELS[t];

    const desc = document.createElement('div');
    desc.className = 'look-desc';
    desc.textContent = THEME_DESC[t] || '';

    card.append(name, desc);
    card.addEventListener('click', () => applyTheme(t));
    gridT.appendChild(card);
  }
  secT.appendChild(gridT);
  inner.appendChild(secT);

  // ── 配色组 ──
  const secP = document.createElement('div');
  secP.className = 'c-section';
  const hP = document.createElement('div');
  hP.className = 'c-section-title';
  hP.textContent = '配色';
  const dP = document.createElement('div');
  dP.className = 'c-section-desc';
  dP.textContent = '只换颜色，不动布局。可与任意主题自由组合。';
  secP.append(hP, dP);

  const gridP = document.createElement('div');
  gridP.className = 'look-grid look-grid--swatch';
  for (const p of PALETTES) {
    const card = document.createElement('button');
    card.className = 'look-swatch';
    card.dataset.palettePick = p;
    card.type = 'button';

    // 色板预览：用该配色的真实变量值画三块色（不写死颜色，避免两处真源）
    const chip = document.createElement('div');
    chip.className = 'swatch-chips';
    for (const v of ['--bg', '--surface-2', '--accent']) {
      const dot = document.createElement('span');
      dot.className = 'swatch-dot';
      dot.style.background = `var(${v})`;
      chip.appendChild(dot);
    }

    const name = document.createElement('div');
    name.className = 'look-name';
    name.textContent = PALETTE_LABELS[p];

    card.append(chip, name);
    card.addEventListener('click', () => applyPalette(p));
    gridP.appendChild(card);
  }
  secP.appendChild(gridP);
  inner.appendChild(secP);

  syncThemeMenu();
}

const THEME_DESC = {
  void:     '极简 · 无框输入 · 零圆角',
  flow:     '流体 · 悬浮输入 · 柔和动效',
  focus:    '专注 · 通宽单栏 · 顶部会话条',
  console:  '终端 · 等宽 · 命令行输入',
  reading:  '阅读 · 衬线正文 · 续写式输入',
};
async function renderSettings(inner, group) {
  inner.innerHTML = '';
  const res = await client.request('config.getAll', {});
  const cfg = res?.config || res || {};

  const h = document.createElement('h2');
  h.textContent = group;
  h.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:16px';
  inner.appendChild(h);

  const entries = flatten(cfg);
  for (const e of entries.slice(0, 40)) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:24px;padding:10px 0;border-bottom:1px solid var(--hair)';

    const k = document.createElement('div');
    k.textContent = e.key;
    k.style.cssText = 'font-size:12px;color:var(--fg-muted)';

    const v = document.createElement('input');
    v.value = String(e.value ?? '');
    v.style.cssText = 'width:240px;height:28px;padding:0 8px;border-radius:4px;border:1px solid var(--line);background:var(--surface-1);color:var(--fg);font-size:12px';
    v.addEventListener('change', async () => {
      try { await client.request('config.set', { key: e.key, value: v.value }); }
      catch (err) { alert(err.message); }
    });

    row.append(k, v);
    inner.appendChild(row);
  }
}

async function renderModel(inner) {
  inner.innerHTML = '';
  const res = await client.request('model.listChannels', {});
  const chans = res?.channels || res || [];

  for (const ch of chans) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:12px 0;border-bottom:1px solid var(--hair)';
    const t = document.createElement('div');
    t.textContent = ch.name || ch.id;
    t.style.cssText = 'font-size:13px;color:var(--fg)';
    row.appendChild(t);
    inner.appendChild(row);
  }
}

async function renderSkills(inner) {
  inner.innerHTML = '';
  const res = await client.request('skill.list', {});
  const list = res?.skills || res || [];

  for (const s of list) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--hair);font-size:12px';
    row.textContent = s.name || s.id;
    row.style.color = 'var(--fg-muted)';
    inner.appendChild(row);
  }
}

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push({ key, value: v });
  }
  return out;
}

/* ═══ 键盘 ═══════════════════════════════════════════════════════════════ */
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      paletteOpen ? closePalette() : openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openTab(null);
      return;
    }
    if (mod && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
      return;
    }
    if (e.key === 'Escape') {
      if (paletteOpen) closePalette();
      else if (!$('page').hidden) $('page').hidden = true;
    }
  });
}

/* ═══ 启动 ═══════════════════════════════════════════════════════════════ */
function bindUI() {
  $('btn-palette').addEventListener('click', openPalette);
  $('btn-settings').addEventListener('click', () => openPage('settings'));
  $('btn-new').addEventListener('click', () => openTab(null));
  $('btn-send').addEventListener('click', send);
  $('btn-stop').addEventListener('click', async () => {
    try { await client.request('message.stop', {}); } catch { /* ignore */ }
  });
  $('page-back').addEventListener('click', () => { $('page').hidden = true; });

  const input = $('input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  for (const b of document.querySelectorAll('.wa')) {
    b.addEventListener('click', () => {
      input.value = b.dataset.p || b.textContent;
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  }

  $('palette').addEventListener('click', (e) => {
    if (e.target === $('palette')) closePalette();
  });
  $('palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
}

client.handlers.onOpen = () => {
  $('conn-dot').dataset.state = 'online';
  $('conn-text').textContent = '已连接';
};

client.handlers.onClose = () => {
  $('conn-dot').dataset.state = 'offline';
  $('conn-text').textContent = '离线';
};

client.handlers.onEvent = (type, payload) => {
  if (type === 'message.delta') {
    const delta = payload?.delta ?? payload?.text ?? '';
    if (!delta) return;
    if (!state.assistantEl) state.assistantEl = appendMsg('assistant', '');
    state.assistantEl.textContent += delta;
    scrollDown();
    return;
  }
  if (type === 'message.done') {
    if (payload?.text && state.assistantEl) state.assistantEl.textContent = payload.text;
    state.assistantEl = null;
    setRunning(false);
    return;
  }
  if (type === 'turn.start') { setRunning(true); return; }
  if (type === 'turn.end') { setRunning(false); return; }
};

initTheme();
bindUI();
bindKeys();
autosize();
renderStripes();
client.connect();
