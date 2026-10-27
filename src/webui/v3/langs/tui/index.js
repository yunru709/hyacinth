/* ============================================================================
   设计语言：TUI — 终端效率

   ══ 立场（2026-10-27 修订）══════════════════════════════════════════════════

     **外表像终端，交互像普通聊天框。** 易用性优先，不为"像终端"牺牲可用性。

     之前的版本是 vim 式模态（NORMAL/INSERT，要按 i 才能输入、j/k 移动、: 命令）。
     孑遗判定："点击 i 才输入这难用的，UI 肯定是易用性为首要的" ⇒ 本轮去掉模态。

   ══ 与其他语言的差别（不是换色）═══════════════════════════════════════════

     布局    全屏分面板，1px 实线分栏，状态栏贴底常显。没有侧栏 —— 是"面板"
     交互    普通聊天框：点击输入框即输入，Enter 发送。鼠标点会话即切换
             （键盘 j/k 等仅在输入框未聚焦时作为"增强"生效，绝不劫持打字）
     控件    方框、反色选中块、字符进度条，无圆角无阴影
     排版    全等宽 12px / 行高 1.4，信息密度最高
     动效    无 —— 任何过渡动画在终端语境里都是噪音

   ══ 为什么用 1px 实线而非字符边框 ═════════════════════════════════════════

     字符边框（┌─┐）需要等宽字体完美对齐，中文混排必然错位。
     lazygit / btop 这类现代 TUI 都用细实线，视觉上更稳且不会崩。

   ══ 交互原则（改这里之前先读）════════════════════════════════════════════

     · 输入框永远可编辑，页面加载即 autofocus —— 没有"进入输入模式"这一步。
     · Enter 发送；不劫持 Tab / 方向键 / 字母键。
     · 键盘快捷键只在输入框**未聚焦**时生效（避免 j/k 顶掉打字）。
     · 会话切换：鼠标单击即打开（不要求先选中、再双击）。
   ========================================================================== */

import { boot, DEMO, PALETTE_LABELS, toEntries } from '../../core/bridge.js';

const app = boot();
const { client, sessions, stream, history } = app;

/* ═══ 应用主题/配色（TUI 也支持换色，但结构永远是 TUI）═══════════════════════ */
document.documentElement.setAttribute('data-theme', app.theme);
document.documentElement.setAttribute('data-palette', app.palette);

/* ═══ 状态 ═══════════════════════════════════════════════════════════════ */
const S = {
  sessionList: [],
  selIndex: 0,
  activeSession: null,
  running: false,
  connected: false,
};

/* ═══ DOM 构建 ══════════════════════════════════════════════════════════════ */
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
    <input class="tui-field" id="tui-field" type="text" autocomplete="off"
           spellcheck="false" placeholder="输入消息，Enter 发送">
  </div>

  <div class="tui-status">
    <span class="tui-conn" id="tui-conn"><span class="tui-dot"></span>offline</span>
    <span class="tui-dim" id="tui-themepal">TUI · ${PALETTE_LABELS[app.palette]}</span>
    <span class="tui-grow"></span>
    <span class="tui-dim tui-help-link" id="tui-help-link" role="button" tabindex="0"
          title="快捷键与说明">?</span>
  </div>
`;

const $ = (id) => document.getElementById(id);
const listEl = $('tui-list');
const logEl = $('tui-log');
const fieldEl = $('tui-field');

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
    // 单击即打开（普通聊天的直觉：点会话就切过去，不用先选中再双击）
    row.addEventListener('click', () => {
      S.selIndex = i;
      openSession(s);
    });
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
  hint.textContent = '— 输入消息开始对话 —';
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
  $('tui-title').textContent = 'LOG · ' + truncate(sessions.titleOf(s), 28);
  logEl.innerHTML = '';
  renderList();

  if (!s.id) {
    const note = document.createElement('div');
    note.className = 'tui-empty';
    note.textContent = '— 新会话，输入消息开始 —';
    logEl.appendChild(note);
    fieldEl.focus();
    return;
  }

  const busy = document.createElement('div');
  busy.className = 'tui-empty';
  busy.textContent = '加载历史…';
  logEl.appendChild(busy);

  const raw = await history.load(s.id);
  logEl.innerHTML = '';
  if (!raw.length) {
    const note = document.createElement('div');
    note.className = 'tui-empty';
    note.textContent = '— 该会话没有消息 —';
    logEl.appendChild(note);
    return;
  }
  // TUI 保留工具调用与思考：信息密度优先
  for (const e of toEntries(raw, { tools: true })) appendLine(e.kind, e.text);
  scrollLog();
}

/* ═══ 键盘：输入优先，快捷键只在未聚焦时生效 ═════════════════════════════ */
function moveSel(delta) {
  if (!S.sessionList.length) return;
  S.selIndex = Math.min(Math.max(S.selIndex + delta, 0), S.sessionList.length - 1);
  renderList();
}

document.addEventListener('keydown', (e) => {
  // ── 输入框聚焦：只处理 Enter 发送，其余（字母/方向键/Tab）全交给输入框 ──
  if (document.activeElement === fieldEl) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
    return;
  }

  // ── 输入框未聚焦：可选键盘增强（绝不劫持打字，因为此时没在打字）──
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      moveSel(1);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      moveSel(-1);
      break;
    case 'Enter':
      e.preventDefault();
      if (S.sessionList[S.selIndex]) openSession(S.sessionList[S.selIndex]);
      break;
    case '?':
      e.preventDefault();
      toggleHelp();
      break;
    case 'Escape':
      if (helpEl) closeHelp();
      else fieldEl.focus(); // Esc 回输入框 —— 任何时候都能立刻接着打字
      break;
    default:
      break;
  }
});

async function submit() {
  const text = fieldEl.value.trim();
  if (!text) return;
  fieldEl.value = '';
  setBusy(true);
  try {
    await stream.send(text);
  } catch (err) {
    setBusy(false);
    appendLine('error', err?.message || '发送失败');
  }
}

/* ═══ 帮助浮层（点击状态栏 ? 或按 ? 打开）══════════════════════════════════ */
let helpEl = null;

function toggleHelp() {
  if (helpEl) { closeHelp(); return; }

  helpEl = document.createElement('div');
  helpEl.className = 'tui-help';

  const box = document.createElement('div');
  box.className = 'tui-help-box';

  const h = document.createElement('div');
  h.className = 'tui-help-title';
  h.textContent = '使用说明';

  const rows = [
    ['输入框', '点一下就打字，Enter 发送'],
    ['会话', '单击左侧任意会话即切换'],
    ['+ new', '开一个新会话'],
    ['j / k', '输入框未聚焦时上下移动'],
    ['Enter', '输入框未聚焦时打开选中会话'],
    ['Esc', '回到输入框'],
    ['?', '开关本说明'],
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

  const close = document.createElement('div');
  close.className = 'tui-help-cmds';
  close.textContent = '点任意处关闭 · Esc 回到输入框';

  box.append(h, table, close);
  helpEl.appendChild(box);
  helpEl.addEventListener('click', closeHelp);
  root.appendChild(helpEl);
}

function closeHelp() {
  if (helpEl) { helpEl.remove(); helpEl = null; }
}

/* ═══ 启动 ═══════════════════════════════════════════════════════════════ */
$('tui-new').addEventListener('click', () => openSession({ id: null, title: '新会话' }));
$('tui-help-link').addEventListener('click', toggleHelp);
$('tui-help-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHelp(); }
});

/* 页面加载即聚焦输入框 —— 用户打开就能直接打字，无需任何"进入"步骤 */
setTimeout(() => fieldEl.focus(), 0);

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
