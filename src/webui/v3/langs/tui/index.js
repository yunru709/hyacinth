/* ============================================================================
   设计语言：TUI — 终端效率

   ══ 立场 ═══════════════════════════════════════════════════════════════════

     键盘优先，鼠标可选。一屏看到尽可能多的状态，操作零延迟。

   ══ 与其他语言的差别（不是换色）═════════════════════════════════════════

     布局    全屏分面板，1px 实线分栏，状态栏贴底常显。没有侧栏 —— 是"面板"
     交互    模态：NORMAL / INSERT / COMMAND / SEARCH / HELP，状态栏显示当前模式
             全键盘：j k 移动、i 插入、/ 搜索、: 命令、? 帮助、Esc 回退
     控件    方框、反色选中块、字符进度条 [====   ]，无圆角无阴影
     排版    全等宽 12px / 行高 1.4，信息密度最高
     动效    无 —— 任何过渡动画在终端语境里都是噪音

   ══ 为什么用 1px 实线而非字符边框 ═══════════════════════════════════════

     字符边框（┌─┐）需要等宽字体完美对齐，中文混排必然错位。
     lazygit / btop 这类现代 TUI 都用细实线，视觉上更稳且不会崩。
   ========================================================================== */

import { boot, DEMO, PALETTE_LABELS, toEntries } from '../../core/bridge.js';

const app = boot();
const { client, sessions, stream, history } = app;

/* ═══ 应用主题/配色（TUI 也支持换色，但结构永远是 TUI）═══════════════════ */
document.documentElement.setAttribute('data-theme', app.theme);
document.documentElement.setAttribute('data-palette', app.palette);

/* ═══ 状态 ═══════════════════════════════════════════════════════════════ */
const S = {
  mode: 'normal',        // normal | insert | command | search | help
  sessionList: [],
  selIndex: 0,
  activeSession: null,
  running: false,
  connected: false,
  cmdBuffer: '',
  searchBuffer: '',
};

/* ═══ DOM 构建 ═══════════════════════════════════════════════════════════ */
const root = document.getElementById('app');
root.className = 'tui';

root.innerHTML = `
  <div class="tui-body">
    <aside class="tui-panel tui-side">
      <div class="tui-panel-head">
        <span>SESSIONS</span>
        <span class="tui-count" id="tui-count">0</span>
      </div>
      <div class="tui-side-list" id="tui-list"></div>
      <div class="tui-side-foot">
        <button class="tui-mini" id="tui-new">+ new</button>
      </div>
    </aside>

    <section class="tui-panel tui-main">
      <div class="tui-panel-head">
        <span id="tui-title">LOG</span>
        <span class="tui-dot" id="tui-busy" hidden></span>
      </div>
      <div class="tui-log" id="tui-log"></div>
    </section>
  </div>

  <div class="tui-inputbar">
    <span class="tui-prompt">&gt;</span>
    <input class="tui-field" id="tui-field" placeholder="i 进入输入 · Enter 发送" readonly>
  </div>

  <div class="tui-status">
    <span class="tui-mode" id="tui-mode">NORMAL</span>
    <span class="tui-dim" id="tui-themepal">TUI · ${PALETTE_LABELS[app.palette]}</span>
    <span class="tui-conn" id="tui-conn"><span class="tui-dot"></span>offline</span>
    <span class="tui-grow"></span>
    <span class="tui-dim">j/k 移动 · i 输入 · / 搜索 · : 命令 · ? 帮助</span>
  </div>
`;

const $ = (id) => document.getElementById(id);
const listEl = $('tui-list');
const logEl = $('tui-log');
const fieldEl = $('tui-field');
const modeEl = $('tui-mode');

/* ═══ 会话列表渲染 ═══════════════════════════════════════════════════════ */
function renderList() {
  $('tui-count').textContent = String(S.sessionList.length);
  listEl.innerHTML = '';

  if (!S.sessionList.length) {
    const e = document.createElement('div');
    e.className = 'tui-empty';
    e.textContent = '(no sessions)';
    listEl.appendChild(e);
    return;
  }

  S.sessionList.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'tui-row';
    if (i === S.selIndex) row.dataset.sel = 'true';
    if (S.activeSession && s.id === S.activeSession) row.dataset.active = 'true';

    const title = document.createElement('span');
    title.className = 'tui-row-title';
    title.textContent = truncate(sessions.titleOf(s) || '未命名', 20);

    const mark = document.createElement('span');
    mark.className = 'tui-row-mark';
    mark.textContent = s.id === S.activeSession ? '*' : ' ';

    row.append(mark, title);
    row.addEventListener('click', () => {
      S.selIndex = i;
      renderList();
    });
    row.addEventListener('dblclick', () => openSession(s));
    listEl.appendChild(row);
  });
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ═══ 日志区 ═════════════════════════════════════════════════════════════ */
let currentAssistantEl = null;

function appendLine(kind, text) {
  const line = document.createElement('div');
  line.className = `tui-line tui-line--${kind}`;

  const prefix = document.createElement('span');
  prefix.className = 'tui-line-prefix';
  prefix.textContent = kind === 'user' ? '`>' : kind === 'assistant' ? '|' : kind === 'error' ? '!' : '.';

  const body = document.createElement('span');
  body.className = 'tui-line-body';
  body.textContent = text;

  line.append(prefix, body);
  logEl.appendChild(line);
  scrollLog();
  return body;
}

function scrollLog() {
  logEl.scrollTop = logEl.scrollHeight;
}

function renderLogEmpty() {
  logEl.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'tui-empty';
  hint.textContent = '— 无消息。按 i 开始输入 —';
  logEl.appendChild(hint);
}

/* ═══ 消息流接线 ═════════════════════════════════════════════════════════ */
stream.handlers.onUserSend = (text) => {
  if (logEl.querySelector('.tui-empty')) logEl.innerHTML = '';
  appendLine('user', text);
  currentAssistantEl = null;
};

stream.handlers.onAssistantStart = () => {
  const body = appendLine('assistant', '');
  currentAssistantEl = body;
};

stream.handlers.onAssistantDelta = (_d, full) => {
  if (!currentAssistantEl) currentAssistantEl = appendLine('assistant', '');
  currentAssistantEl.textContent = full;
  scrollLog();
};

stream.handlers.onAssistantDone = (text) => {
  if (!currentAssistantEl) currentAssistantEl = appendLine('assistant', '');
  currentAssistantEl.textContent = text || '';
  currentAssistantEl = null;
  setBusy(false);
  scrollLog();
};

stream.handlers.onTurnStart = () => setBusy(true);
stream.handlers.onTurnEnd = () => setBusy(false);

client.handlers.onOpen = () => {
  S.connected = true;
  $('tui-conn').innerHTML = '<span class="tui-dot" data-on="true"></span>online';
};

/* 拉数据必须等 onReady（ui.connected）—— 在 onOpen 里拉会被静默丢弃。 */
client.handlers.onReady = () => { loadSessions(); };

client.handlers.onClose = () => {
  S.connected = false;
  $('tui-conn').innerHTML = '<span class="tui-dot"></span>offline';
};

function setBusy(on) {
  S.running = on;
  $('tui-busy').hidden = !on;
}

/* ═══ 会话操作 ═══════════════════════════════════════════════════════════ */
async function loadSessions() {
  S.sessionList = await sessions.list();
  renderList();
}

async function openSession(s) {
  S.activeSession = s.id;
  $("tui-title").textContent = "LOG · " + truncate(sessions.titleOf(s), 28);
  logEl.innerHTML = "";
  renderList();

  if (!s.id) {
    const note = document.createElement("div");
    note.className = "tui-empty";
    note.textContent = "— 新会话，按 i 开始输入 —";
    logEl.appendChild(note);
    return;
  }

  const busy = document.createElement("div");
  busy.className = "tui-empty";
  busy.textContent = "加载历史…";
  logEl.appendChild(busy);

  const raw = await history.load(s.id);
  logEl.innerHTML = "";
  if (!raw.length) {
    const note = document.createElement("div");
    note.className = "tui-empty";
    note.textContent = "— 该会话没有消息 —";
    logEl.appendChild(note);
    return;
  }
  // TUI 保留工具调用与思考：信息密度优先
  for (const e of toEntries(raw, { tools: true })) appendLine(e.kind, e.text);
  scrollLog();
}


/* ═══ 模态与键盘 ═════════════════════════════════════════════════════════ */
function setMode(m) {
  S.mode = m;
  modeEl.textContent = m.toUpperCase();
  modeEl.dataset.mode = m;

  if (m === 'insert') {
    fieldEl.readOnly = false;
    fieldEl.placeholder = 'Enter 发送 · Esc 退出';
    fieldEl.focus();
  } else {
    fieldEl.readOnly = true;
    fieldEl.placeholder = 'i 进入输入 · Enter 发送';
    if (document.activeElement === fieldEl) fieldEl.blur();
  }
}

document.addEventListener('keydown', (e) => {
  // INSERT 模式：只处理 Esc 与 Enter，其余交给输入框
  if (S.mode === 'insert') {
    if (e.key === 'Escape') { e.preventDefault(); setMode('normal'); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    return;
  }

  // 其余模式：全局键
  switch (e.key) {
    case 'j':
      e.preventDefault();
      if (S.sessionList.length) {
        S.selIndex = Math.min(S.selIndex + 1, S.sessionList.length - 1);
        renderList();
      }
      break;

    case 'k':
      e.preventDefault();
      S.selIndex = Math.max(S.selIndex - 1, 0);
      renderList();
      break;

    case 'Enter':
      e.preventDefault();
      if (S.sessionList[S.selIndex]) openSession(S.sessionList[S.selIndex]);
      break;

    case 'i':
      e.preventDefault();
      setMode('insert');
      break;

    case '?':
      e.preventDefault();
      toggleHelp();
      break;

    case ':':
      e.preventDefault();
      setMode('command');
      promptCommand();
      break;

    case '/':
      e.preventDefault();
      setMode('search');
      promptSearch();
      break;

    case 'Escape':
      if (S.mode !== 'normal') setMode('normal');
      break;

    default:
      break;
  }
});

async function submit() {
  const text = fieldEl.value.trim();
  if (!text) { setMode('normal'); return; }
  fieldEl.value = '';
  setMode('normal');
  setBusy(true);
  try {
    await stream.send(text);
  } catch (err) {
    setBusy(false);
    appendLine('error', err?.message || '发送失败');
  }
}

/* ═══ 命令面板（: 唤起）═════════════════════════════════════════════════ */
const COMMANDS = [
  { name: 'theme', desc: '切换主题：:theme <void|flow|focus|console|reading>' },
  { name: 'palette', desc: '切换配色：:palette <night|day|sepia|mono|forest>' },
  { name: 'new', desc: '新会话' },
  { name: 'reload', desc: '重载会话列表' },
  { name: 'help', desc: '显示帮助' },
  { name: 'q', desc: '关闭帮助' },
];

function promptCommand() {
  const raw = window.prompt('命令：');
  setMode('normal');
  if (!raw) return;

  const [cmd, ...args] = raw.trim().split(/\s+/);
  const arg = args.join(' ');

  switch (cmd) {
    case 'theme':
      if (arg) { app.setTheme(arg); $('tui-themepal').textContent = `TUI · ${PALETTE_LABELS[arg] || arg}`; }
      break;
    case 'palette':
      if (arg) { app.setPalette(arg); $('tui-themepal').textContent = `${app.theme}/${arg}`; }
      break;
    case 'new':
      openSession({ id: null, title: '新会话' });
      break;
    case 'reload':
      loadSessions();
      break;
    case 'help':
      toggleHelp();
      break;
    case 'q':
      closeHelp();
      break;
    default:
      appendLine('error', `未知命令: ${cmd}（? 查看帮助）`);
  }
}

function promptSearch() {
  const kw = window.prompt('搜索会话：');
  setMode('normal');
  if (!kw) return;
  const hit = S.sessionList.findIndex((s) => (sessions.titleOf(s) || '').includes(kw));
  if (hit >= 0) { S.selIndex = hit; renderList(); }
  else appendLine('error', `未找到: ${kw}`);
}

/* ═══ 帮助浮层 ═══════════════════════════════════════════════════════════ */
let helpEl = null;

function toggleHelp() {
  if (helpEl) { closeHelp(); return; }

  helpEl = document.createElement('div');
  helpEl.className = 'tui-help';

  const box = document.createElement('div');
  box.className = 'tui-help-box';

  const h = document.createElement('div');
  h.className = 'tui-help-title';
  h.textContent = 'KEYS';

  const rows = [
    ['j / k', '上下移动会话'],
    ['Enter', '打开选中会话'],
    ['i', '进入输入模式'],
    ['Esc', '回到 NORMAL'],
    ['/', '搜索会话'],
    [':', '命令'],
    ['?', '开关本帮助'],
  ];

  const table = document.createElement('div');
  table.className = 'tui-help-table';
  for (const [k, v] of rows) {
    const kr = document.createElement('span');
    kr.className = 'tui-help-key';
    kr.textContent = k;
    const vr = document.createElement('span');
    vr.className = 'tui-help-val';
    vr.textContent = v;
    table.append(kr, vr);
  }

  const cmds = document.createElement('div');
  cmds.className = 'tui-help-cmds';
  cmds.textContent = COMMANDS.map((c) => ':' + c.name + '  ' + c.desc).join('\n');

  box.append(h, table, cmds);
  helpEl.appendChild(box);
  helpEl.addEventListener('click', closeHelp);
  root.appendChild(helpEl);
}

function closeHelp() {
  if (helpEl) { helpEl.remove(); helpEl = null; }
  if (S.mode === 'help') setMode('normal');
}

/* ═══ 启动 ═══════════════════════════════════════════════════════════════ */
$('tui-new').addEventListener('click', () => openSession({ id: null, title: '新会话' }));
setMode('normal');

/* ?demo=1 时不连后端 —— 空界面无法公平评判设计语言，
   「什么都没画」和「画得不好」在截图里长得一样。 */
if (DEMO.isDemo()) {
  S.sessionList = DEMO.sessions;
  S.selIndex = 0;
  S.activeSession = 's1';
  $('tui-title').textContent = 'LOG · ' + DEMO.sessions[0].title;
  logEl.innerHTML = '';
  for (const m of DEMO.messages) appendLine(m.role === 'user' ? 'user' : 'assistant', m.text);
  renderList();
  $('tui-conn').innerHTML = '<span class="tui-dot" data-on="true"></span>demo';
} else {
  renderLogEmpty();
  client.connect();
}
