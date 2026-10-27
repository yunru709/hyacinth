/* ══════════════════════════════════════════════════════════════════════════
   classic —— 桌面应用式的设计语言
   ══════════════════════════════════════════════════════════════════════════

   来源：这是"最初版本"(v1) 的形态 —— 顶栏 + 侧栏 + 消息流 + 输入区三段式。

   ⚠️ 但**代码是全新的**，不是把 v1 的 8352 行搬过来。
      v1 在页面切换、元素交互、状态残留上有不少问题；为了复用而带上这些
      包袱不划算。这里只保留"形态与功能范围"，实现全部重写：
        · 请求时机     → 交给 core 的 onReady（v1 的坑：在 ws.onopen 发会被丢弃）
        · 事件名       → 交给 core 的 MessageStream（v1 的坑：message.delta 根本不存在）
        · 历史合并     → 交给 core 的 toEntries（v1 的坑：thinking/text 交替会碎段落）
        · 状态残留     → 每次切会话整块重绘，不做增量 patch

   设计语言差异（对比 tui / editorial）：
        tui        全等宽、键盘模态、反色选中
        editorial  单栏无界面、衬线、只剩文字
        classic    三带 chrome、气泡对话、圆角卡片 —— 最"像个应用"
   ══════════════════════════════════════════════════════════════════════════ */

import { boot, DEMO, toEntries } from '../../core/bridge.js';
import { renderMarkdown } from '../../core/markdown.js';
import { renderSettingsGroup } from '../../core/form.js';
import { SETTINGS_GROUPS, loadValues } from '../../core/settings.js';

const app = boot();
const { client, sessions, stream, history } = app;

const S = {
  connected: false,
  activeId: null,
  sessionList: [],
  busy: false,
  /** 当前正在流式增长的助生气泡；一次只可能有一个 */
  liveBubble: null,
  /** 当前正在流式的工具卡片（按 tool id 索引） */
  toolCards: new Map(),
};

const $ = (id) => document.getElementById(id);

/* ═══ DOM ═════════════════════════════════════════════════════════════════ */

document.getElementById('app').innerHTML = `
<div class="bru">
  <header class="bru-top">
    <div class="bru-brand">
      <span class="bru-logo"></span>
      <span class="bru-title">Hyacinth</span>
    </div>
    <button class="bru-new" id="bru-new" type="button">＋ 新会话</button>
    <div class="bru-spacer"></div>
    <div class="bru-conn" id="bru-conn"><span class="bru-dot"></span><span>连接中…</span></div>
    <button class="bru-iconbtn" id="bru-settings" type="button" title="设置">设置</button>
  </header>

  <div class="bru-body">
    <aside class="bru-side">
      <div class="bru-search-wrap">
        <input class="bru-search" id="bru-search" type="text" placeholder="搜索会话" />
      </div>
      <div class="bru-list" id="bru-list"></div>
    </aside>

    <main class="bru-main">
      <div class="bru-stream" id="bru-stream"></div>
      <div class="bru-composer">
        <div class="bru-inputbox">
          <textarea id="bru-input" rows="1" placeholder="发消息…  Enter 发送 · Shift+Enter 换行"></textarea>
          <button class="bru-mic" id="bru-mic" type="button" title="语音输入（需在设置里启用）" hidden>●</button>
          <button class="bru-send" id="bru-send" type="button">发送</button>
        </div>
        <div class="bru-hint" id="bru-hint"></div>
      </div>
    </main>
  </div>

  <section class="bru-settings" id="bru-settings-view" hidden>
    <header class="bru-set-top">
      <button class="bru-backbtn" id="bru-set-back" type="button">← 返回对话</button>
      <div class="bru-set-headtitle">设置</div>
      <div class="bru-spacer"></div>
      <span class="bru-set-toast" id="bru-set-toast"></span>
    </header>
    <div class="bru-set-main">
      <nav class="bru-set-nav" id="bru-set-nav"></nav>
      <div class="bru-set-content" id="bru-set-content"></div>
    </div>
  </section>
</div>`;

const streamEl = $('bru-stream');
const listEl = $('bru-list');
const inputEl = $('bru-input');
const sendEl = $('bru-send');
const hintEl = $('bru-hint');
const connEl = $('bru-conn');

/* ═══ 小工具 ══════════════════════════════════════════════════════════════ */

function scrollBottom() {
  streamEl.scrollTop = streamEl.scrollHeight;
}

function setConn(kind, text) {
  connEl.dataset.state = kind;
  connEl.lastElementChild.textContent = text;
}

function setBusy(on) {
  S.busy = on;
  sendEl.disabled = on;
  sendEl.textContent = on ? '生成中' : '发送';
}

function setHint(text) {
  hintEl.textContent = text || '';
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

function nearBottom() {
  return streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 80;
}

/* ═══ 会话列表 ════════════════════════════════════════════════════════════ */

function renderSessions() {
  const kw = ($('bru-search').value || '').trim().toLowerCase();
  const rows = S.sessionList.filter(
    (s) => !kw || sessions.titleOf(s).toLowerCase().includes(kw),
  );

  listEl.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'bru-list-empty';
    empty.textContent = kw ? '没有匹配的会话' : '还没有会话';
    listEl.appendChild(empty);
    return;
  }

  for (const s of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bru-item' + (s.id === S.activeId ? ' is-active' : '');
    row.dataset.id = s.id;

    const name = document.createElement('span');
    name.className = 'bru-item-name';
    name.textContent = sessions.titleOf(s);

    const dot = document.createElement('span');
    dot.className = 'bru-item-dot';

    row.append(name, dot);
    row.addEventListener('click', () => openSession(s.id));
    listEl.appendChild(row);
  }
}

async function loadSessions() {
  try {
    S.sessionList = await sessions.list();
  } catch (err) {
    console.warn('[classic] session.list 失败', err);
    S.sessionList = [];
  }
  renderSessions();
}

/* ═══ 消息渲染 ═══════════════════════════════════════════════════════════ */

/** 一条消息 = 行容器 + 气泡。role: 'user' | 'assistant' | 'error' */
function bubble(role, text = '') {
  const row = document.createElement('div');
  row.className = `bru-msg bru-msg--${role}`;

  const b = document.createElement('div');
  b.className = 'bru-bubble';
  /* 对话正文走 Markdown；工具卡片/提示语仍是纯文本 */
  if (role === 'user' || role === 'assistant') b.innerHTML = renderMarkdown(text);
  else b.textContent = text;

  row.appendChild(b);
  streamEl.appendChild(row);
  return b;
}

/** 工具调用卡片：默认收起，点标题展开。
    单条工具结果可能是几十 KB，绝不能直接铺在对话里。 */
function toolCard(name, summary) {
  const card = document.createElement('details');
  card.className = 'bru-tool';

  const head = document.createElement('summary');
  head.className = 'bru-tool-head';

  const nm = document.createElement('span');
  nm.className = 'bru-tool-name';
  nm.textContent = name;

  const sm = document.createElement('span');
  sm.className = 'bru-tool-summary';
  sm.textContent = summary || '';

  head.append(nm, sm);

  const body = document.createElement('pre');
  body.className = 'bru-tool-body';
  body.textContent = '运行中…';

  card.append(head, body);
  streamEl.appendChild(card);
  return body;
}

function clearStream() {
  streamEl.innerHTML = '';
  S.liveBubble = null;
  S.toolCards.clear();
}

function emptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'bru-empty';

  const h = document.createElement('div');
  h.className = 'bru-empty-title';
  h.textContent = '开始对话';

  const p = document.createElement('div');
  p.className = 'bru-empty-sub';
  p.textContent = '在下面输入，或从左侧选一个已有会话。';

  wrap.append(h, p);
  streamEl.appendChild(wrap);
}

/* ═══ 打开会话 ════════════════════════════════════════════════════════════ */

async function openSession(id) {
  S.activeId = id;
  S.liveBubble = null;
  renderSessions();
  clearStream();
  setHint('');

  if (!id) {
    emptyState();
    inputEl.focus();
    return;
  }

  const note = document.createElement('div');
  note.className = 'bru-loading';
  note.textContent = '加载历史…';
  streamEl.appendChild(note);

  const raw = await history.load(id);
  /* ⚠️ 切换会话是异步的：加载期间用户可能又点了别的会话，
     回来时必须校验还是不是同一个，否则会把 A 的内容画进 B。 */
  if (S.activeId !== id) return;

  clearStream();
  if (!raw.length) {
    emptyState();
    return;
  }

  /* 历史渲染的取舍（classic 的立场：像个应用，不要过程噪音）
     · thinking 不铺进对话流 —— 只保留"说了什么"
     · 相邻 assistant 段合并进同一个气泡 —— 否则一轮里多段 text 看起来像刷屏
     实测：42 条事件里 text 与 thinking 交替，逐条渲染会变成十几个碎气泡。 */
  let lastAssistant = null;
  for (const e of toEntries(raw, { tools: true })) {
    if (e.kind === 'thinking') continue;

    if (e.kind === 'user') {
      lastAssistant = null;
      bubble('user', e.text);
    } else if (e.kind === 'assistant') {
      if (lastAssistant) lastAssistant.textContent += '\n\n' + e.text;
      else lastAssistant = bubble('assistant', e.text);
    } else if (e.kind === 'tool') {
      lastAssistant = null;
      const sp = e.text.indexOf(' ');
      const name = sp > 0 ? e.text.slice(0, sp) : e.text;
      const summary = sp > 0 ? e.text.slice(sp + 1) : '';
      const body = toolCard(name, summary);
      body.textContent = '（历史未保留输出）';
    } else if (e.kind === 'result') {
      const card = streamEl.lastElementChild;
      if (card && card.tagName === 'DETAILS') {
        card.querySelector('.bru-tool-body').textContent = e.text;
      }
    }
  }
  scrollBottom();
  inputEl.focus();
}

/* ═══ 发送 ════════════════════════════════════════════════════════════════ */

async function submit() {
  const text = (inputEl.value || '').trim();
  if (!text || S.busy) return;

  inputEl.value = '';
  autosize();
  setHint('');

  const hadEmpty = streamEl.querySelector('.bru-empty');
  if (hadEmpty) streamEl.innerHTML = '';

  try {
    await stream.send(text);
  } catch (err) {
    bubble('error', `发送失败：${err?.message ?? err}`);
  }
}

/* ═══ 实时事件接线 ═══════════════════════════════════════════════════════ */

stream.handlers.onUserSend = (text) => {
  bubble('user', text);
  scrollBottom();
};

stream.handlers.onTurnStart = () => {
  setBusy(true);
  S.liveBubble = null;
};

stream.handlers.onAssistantDelta = (_delta, full) => {
  /* 流式：第一次到达时建气泡，之后原地替换全文。
     ⚠️ 必须用 full 替换而不是追加 —— core 传来的 full 已经是累积结果，
        再追加会变成"你好你好你好"。 */
  if (!S.liveBubble) {
    S.liveBubble = bubble('assistant', '');
    S.liveBubble.parentElement.classList.add('is-live');
  }
  const stick = nearBottom();
  S.liveBubble.innerHTML = renderMarkdown(full);
  if (stick) scrollBottom();
};

stream.handlers.onAssistantDone = (text) => {
  if (S.liveBubble) {
    S.liveBubble.innerHTML = renderMarkdown(text);
    S.liveBubble.parentElement.classList.remove('is-live');
    S.liveBubble = null;
  } else if (text) {
    bubble('assistant', text);
  }
  scrollBottom();
};

stream.handlers.onThinking = (text) => {
  /* classic 把思考做成"正在输入"的低调提示，不铺满屏幕。
     详细的 thinking 内容留在历史里，实时只看状态。 */
  if (S.busy) setHint(text ? text.slice(0, 60) : '思考中…');
};

stream.handlers.onToolUse = (name, summary) => {
  const body = toolCard(name, summary);
  S.toolCards.set(name + '#' + S.toolCards.size, body);
  scrollBottom();
};

stream.handlers.onToolResult = (text, isError) => {
  const cards = [...S.toolCards.values()];
  const body = cards[cards.length - 1];
  if (body) {
    body.textContent = text || '（空）';
    if (isError) body.parentElement.classList.add('is-error');
  }
  scrollBottom();
};

stream.handlers.onTurnEnd = () => {
  setBusy(false);
  setHint('');
  S.liveBubble = null;
  /* 一轮结束才刷新侧栏（v1 的教训：每个 chunk 都刷 session.list 会乘上 token 数） */
  loadSessions();
};

stream.handlers.onError = (message) => {
  setBusy(false);
  bubble('error', message);
  scrollBottom();
};

stream.handlers.onInterrupt = () => {
  setBusy(false);
  bubble('error', '已中断');
};

/* ═══ 连接 ═══════════════════════════════════════════════════════════════ */

client.handlers.onOpen = () => {
  setConn('wait', '握手中…');
};

/* ⚠️ 拉数据必须等 ui.connected（后端 attach 完成）。
   在 onOpen 里发请求会被静默丢弃 —— v1 app.js:8310 有注释，但我们不吃这个亏。 */
client.handlers.onReady = async () => {
  S.connected = true;
  setConn('on', '在线');
  await loadSessions();
};

client.handlers.onClose = () => {
  S.connected = false;
  setConn('off', '离线');
};

client.handlers.onError = () => {
  setConn('off', '连接异常');
};

/* ═══ 交互 ═══════════════════════════════════════════════════════════════ */

inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
sendEl.addEventListener('click', submit);
$('bru-search').addEventListener('input', renderSessions);
$('bru-settings').addEventListener('click', () => {
  if (isSettingsOpen()) closeSettings();
  else void openSettings();
});
$('bru-set-back').addEventListener('click', closeSettings);
/* Esc 关闭设置：用户改完想回到对话，不该被迫去找某个按钮 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isSettingsOpen() && !$('bru-drawer')) closeSettings();
});
$('bru-mic').addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') stopRec();
  else startRec();
});
$('bru-new').addEventListener('click', () => {
  /* 新会话：不预先创建，等第一条消息由后端铸 id（与 core 一致） */
  S.activeId = null;
  clearStream();
  emptyState();
  renderSessions();
  inputEl.focus();
});

/* ═══ 设置（整页视图）══════════════════════════════════════════════════

   交互设计（对齐 v1 的信息架构，但补上 v1 缺的闭环）：
     进入  顶栏「设置」→ 整页覆盖对话区
     导航  左侧 6 个分组，点击切换；右侧只渲染当前组（不一路滚）
     修改  控件即改即存；行内右侧显示「已保存 / 保存失败」，顶部也闪一次
     返回  ①「← 返回对话」 ② Esc ③ 再点一次顶栏「设置」
     状态  语音组顶部显示模型/引擎就绪情况（只读，不是可点的开关） */

/** 设置值缓存：打开一次读一次，切分组不重复请求 */
let settingsValues = null;
/** 当前分组 */
let settingsGroupId = null;

function setToast(text, ok) {
  const t = $('bru-set-toast');
  t.textContent = text;
  t.className = 'bru-set-toast ' + (ok ? 'is-ok' : 'is-err');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.textContent = ''; t.className = 'bru-set-toast'; }, 1600);
}

function renderSetNav() {
  const nav = $('bru-set-nav');
  nav.innerHTML = '';
  for (const g of SETTINGS_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bru-set-navitem' + (g.id === settingsGroupId ? ' is-active' : '');
    b.textContent = g.label;
    b.addEventListener('click', () => {
      if (settingsGroupId === g.id) return;
      settingsGroupId = g.id;
      renderSetNav();
      void renderSetGroup(g.id);
    });
    nav.appendChild(b);
  }
}

async function renderSetGroup(id) {
  const g = SETTINGS_GROUPS.find((x) => x.id === id);
  const content = $('bru-set-content');
  content.innerHTML = '<div class="bru-loading">加载…</div>';
  content.scrollTop = 0;
  await renderSettingsGroup(content, {
    group: g,
    values: settingsValues,
    app,
    onSaved: (path, val, ok) => {
      setToast(ok ? '已保存' : '保存失败', ok);
      if (path === 'stt.enabled') syncMicVisibility(val === true);
    },
  });
}

async function openSettings() {
  const view = $('bru-settings-view');
  view.hidden = false;
  settingsGroupId = settingsGroupId || SETTINGS_GROUPS[0].id;
  try {
    if (!settingsValues) settingsValues = await loadValues(app);
  } catch (err) {
    $('bru-set-content').innerHTML = '<div class="bru-loading">读取配置失败，见控制台。</div>';
    console.warn('[classic] loadValues 失败', err);
    return;
  }
  renderSetNav();
  await renderSetGroup(settingsGroupId);
}

function closeSettings() {
  $('bru-settings-view').hidden = true;
  inputEl.focus();
}

function isSettingsOpen() {
  return !$('bru-settings-view').hidden;
}
/* ═══ 语音输入 ════════════════════════════════════════════════════════════ */

let recorder = null;
let chunks = [];

function syncMicVisibility(enabled) {
  $('bru-mic').hidden = !enabled;
}

async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const buf = await blob.arrayBuffer();
      /* base64（去掉 data: 前缀） */
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      setHint('识别中…');
      const text = await app.voice.transcribe(btoa(bin), 'webm');
      if (text) {
        inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + text;
        autosize();
        inputEl.focus();
        setHint('');
      } else {
        setHint('没识别到内容');
      }
    };
    recorder.start();
    $('bru-mic').classList.add('is-rec');
    setHint('录音中… 再点一次结束');
  } catch (err) {
    setHint('无法访问麦克风：' + (err?.message ?? err));
  }
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  $('bru-mic').classList.remove('is-rec');
}

/* ═══ 启动 ═══════════════════════════════════════════════════════════════ */

autosize();
if (DEMO.isDemo()) {
  S.sessionList = DEMO.sessions;
  S.activeId = 's1';
  renderSessions();
  clearStream();
  for (const m of DEMO.messages) bubble(m.role === 'user' ? 'user' : 'assistant', m.text);
  setConn('on', '在线');
  setHint('演示数据');
} else {
  renderSessions();
  emptyState();
  client.connect();
  /* 语音输入是否显示，取决于配置 stt.enabled */
  app.config.get('stt.enabled').then((on) => syncMicVisibility(on === true)).catch(() => {});
}
