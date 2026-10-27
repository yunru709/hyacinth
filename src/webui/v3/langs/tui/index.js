/* ============================================================================
   设计语言：TUI — 终端效率

   ══ 立场（2026-10-27 修订）══════════════════════════════════════════════════

     **外表像终端，交互像普通聊天框。** 易用性优先，不为"像终端"牺牲可用性。

     两轮修订：
       · 去 vim 模态（NORMAL/INSERT/i 输入）——孑遗："点击 i 才输入这难用的"。
       · 补齐相对 v1/v3-classic 缺失的功能：Markdown 渲染 / 设置面板 / 语音输入。

   ══ 与其他语言的差别（不是换色）═══════════════════════════════════════════

     布局    全屏分面板，1px 实线分栏，状态栏贴底常显。没有侧栏 —— 是"面板"
     交互    普通聊天框：点击输入框即输入，Enter 发送。鼠标点会话即切换
             （键盘 j/k 等仅在输入框未聚焦时作为"增强"生效，绝不劫持打字）
     控件    方框、反色选中块、字符进度条，无圆角无阴影
     排版    全等宽 12px / 行高 1.4，信息密度最高
     动效    无 —— 任何过渡动画在终端语境里都是噪音

   ══ 功能范围（与 classic 对齐，全部走 core，不自己拼 RPC）═════════════════

     对话 Markdown 渲染 · 历史加载 · 流式输出 · 工具/思考行
     设置 6 组（模型/上下文/工具/语音/外观/高级），复用 core/form + core/settings
     语音输入（stt.enabled 控制显隐）· 会话列表/新建/切换
     配色/主题切换（: 命令已删，改由设置面板驱动）

   ══ 交互原则（改这里之前先读）════════════════════════════════════════════

     · 输入框永远可编辑，页面加载即 autofocus —— 没有"进入输入模式"这一步。
     · Enter 发送；不劫持 Tab / 方向键 / 字母键。
     · 快捷键(j/k/?/Esc)只在「没有任何输入框聚焦」时生效（别把设置里的数字框顶掉）。
     · 会话切换：鼠标单击即打开。
   ========================================================================== */

import { boot, DEMO, PALETTE_LABELS, toEntries } from '../../core/bridge.js';
import { renderMarkdown } from '../../core/markdown.js';
import { renderSettingsGroup } from '../../core/form.js';
import { SETTINGS_GROUPS, loadValues } from '../../core/settings.js';
import { createPanel } from '../../core/panel.js';

const app = boot();
const { client, sessions, stream, history } = app;
/* 调试口：把 app 挂到 window，方便控制台/探针直接调 domains（无害，便于日后排查）。 */
window.__v3 = app;

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
    <span class="tui-dim" id="tui-themepal">Terminal · ${PALETTE_LABELS[app.palette]}</span>
    <span class="tui-grow"></span>
    <button class="tui-status-btn" id="tui-mic" type="button" title="语音输入（需在设置里启用）" hidden>◉ mic</button>
    <button class="tui-status-btn" id="tui-panel-btn" type="button" title="控制台（模型/能力/运行/会话）">⊞ 控制台</button>
    <button class="tui-status-btn" id="tui-settings-btn" type="button" title="设置">⚙ 设置</button>
    <span class="tui-status-btn" id="tui-help-link" role="button" tabindex="0" title="使用说明">?</span>
  </div>

  <div class="tui-settings" id="tui-settings" hidden>
    <div class="tui-set-box">
      <div class="tui-set-head">
        <span class="tui-set-title">SETTINGS</span>
        <span class="tui-set-toast" id="tui-set-toast"></span>
        <span class="tui-grow"></span>
        <span class="tui-set-close" id="tui-set-close" role="button" tabindex="0">[ 关闭 Esc ]</span>
      </div>
      <div class="tui-set-body">
        <nav class="tui-set-nav" id="tui-set-nav"></nav>
        <div class="tui-set-content" id="tui-set-content"></div>
      </div>
    </div>
  </div>
`;

const $ = (id) => document.getElementById(id);
const listEl = $('tui-list');
const logEl = $('tui-log');
const fieldEl = $('tui-field');
/* 控制台浮层句柄（由 panel.js 在 startup 创建） */
let panel = null;

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

/* assistant 行用 Markdown 渲染（代码块/列表/加粗可读）；user/error/sys 保持纯文本，
   避免用户输入里的符号被渲染成结构。renderMarkdown 内部先 escapeHtml 再套规则，安全。 */
function appendLine(kind, text) {
  const line = document.createElement('div');
  line.className = `tui-line tui-line--${kind}`;

  const prefix = document.createElement('span');
  prefix.className = 'tui-line-prefix';
  prefix.textContent = kind === 'user' ? '`>' : kind === 'assistant' ? '|' : kind === 'error' ? '!' : '.';

  const body = document.createElement('div');
  body.className = 'tui-line-body';
  if (kind === 'assistant') body.innerHTML = renderMarkdown(text || '');
  else body.textContent = text;

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
  currentAssistantEl.innerHTML = renderMarkdown(full || '');
  scrollLog();
};

stream.handlers.onAssistantDone = (text) => {
  if (!currentAssistantEl) currentAssistantEl = appendLine('assistant', '');
  currentAssistantEl.innerHTML = renderMarkdown(text || '');
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
client.handlers.onReady = () => {
  loadSessions();
  // 语音输入是否显示，取决于配置 stt.enabled
  app.config.get('stt.enabled').then((on) => syncMicVisibility(on === true)).catch(() => {});
};

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
  fieldEl.focus();
}

/* ═══ 键盘：输入优先，快捷键只在没有输入框聚焦时生效 ═════════════════════ */
function isTypingElsewhere() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable;
}

function moveSel(delta) {
  if (!S.sessionList.length) return;
  S.selIndex = Math.min(Math.max(S.selIndex + delta, 0), S.sessionList.length - 1);
  renderList();
}

document.addEventListener('keydown', (e) => {
  // 浮层（设置 / 控制台）打开时 Esc 关闭（无论焦点在哪）
  if (e.key === 'Escape') {
    if (isSettingsOpen()) { e.preventDefault(); closeSettings(); return; }
    if (panel && panel.isOpen()) { e.preventDefault(); panel.close(); return; }
  }

  // 有输入框聚焦：只处理「主输入框的 Enter 发送」，其余全交给控件本身
  if (isTypingElsewhere()) {
    if (document.activeElement === fieldEl && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
    return;
  }

  // 无输入框聚焦：可选键盘增强
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
      else fieldEl.focus();
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

/* ═══ 设置面板（复用 core/form + core/settings，走终端风外观）═══════════════ */
let settingsValues = null;
let settingsGroupId = null;

function setSetToast(text, ok) {
  const t = $('tui-set-toast');
  t.textContent = text;
  t.className = 'tui-set-toast ' + (ok ? 'is-ok' : 'is-err');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.textContent = ''; t.className = 'tui-set-toast'; }, 1600);
}

function renderSetNav() {
  const nav = $('tui-set-nav');
  nav.innerHTML = '';
  for (const g of SETTINGS_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tui-set-navitem' + (g.id === settingsGroupId ? ' is-active' : '');
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
  const content = $('tui-set-content');
  content.innerHTML = '<div class="tui-set-loading">加载…</div>';
  content.scrollTop = 0;
  await renderSettingsGroup(content, {
    group: g,
    values: settingsValues,
    app,
    onSaved: (path, val, ok) => {
      setSetToast(ok ? '已保存' : '保存失败', ok);
      if (path === 'stt.enabled') syncMicVisibility(val === true);
    },
  });
}

async function openSettings() {
  $('tui-settings').hidden = false;
  settingsGroupId = settingsGroupId || SETTINGS_GROUPS[0].id;
  try {
    if (!settingsValues) settingsValues = await loadValues(app);
  } catch (err) {
    $('tui-set-content').innerHTML = '<div class="tui-set-loading">读取配置失败，见控制台。</div>';
    console.warn('[tui] loadValues 失败', err);
    return;
  }
  renderSetNav();
  await renderSetGroup(settingsGroupId);
}

function closeSettings() {
  $('tui-settings').hidden = true;
  fieldEl.focus();
}

function isSettingsOpen() {
  return !$('tui-settings').hidden;
}

/* ═══ 语音输入（stt.enabled 控制显隐）═══════════════════════════════════════ */
let recorder = null;
let recChunks = [];

function syncMicVisibility(enabled) {
  const mic = $('tui-mic');
  if (mic) mic.hidden = !enabled;
}

async function startRec() {
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(media);
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      media.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      const buf = await blob.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      $('tui-mic').textContent = '… 识别中';
      try {
        const text = await app.voice.transcribe(btoa(bin), 'webm');
        if (text) {
          fieldEl.value = (fieldEl.value ? fieldEl.value + ' ' : '') + text;
          fieldEl.focus();
        } else {
          appendLine('error', '没识别到内容');
        }
      } catch (err) {
        appendLine('error', '识别失败：' + (err?.message ?? err));
      } finally {
        $('tui-mic').textContent = '◉ mic';
        $('tui-mic').classList.remove('is-rec');
      }
    };
    recorder.start();
    $('tui-mic').classList.add('is-rec');
    $('tui-mic').textContent = '■ 停止';
  } catch (err) {
    appendLine('error', '无法访问麦克风：' + (err?.message ?? err));
  }
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  $('tui-mic').classList.remove('is-rec');
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
    ['⚙ 设置', '模型/语音/参数等 6 组设置'],
    ['◉ mic', '语音输入（设置里启用后出现）'],
    ['+ new', '开一个新会话'],
    ['j / k', '输入框未聚焦时上下移动'],
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

/* 控制台浮层（模型/能力/运行/会话），复用 .tui-set-* 外壳 */
panel = createPanel(app, {
  reloadSessions: loadSessions,
  getSessions: () => S.sessionList,
  titleOf: (s) => sessions.titleOf(s),
  insertText: (t) => {
    panel.close();
    fieldEl.value = (fieldEl.value ? fieldEl.value + ' ' : '') + t;
    fieldEl.focus();
  },
});
$('tui-panel-btn').addEventListener('click', () => { closeSettings(); panel.open(); });

$('tui-settings-btn').addEventListener('click', () => { if (panel) panel.close(); openSettings(); });
$('tui-set-close').addEventListener('click', closeSettings);
$('tui-set-close').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeSettings(); }
});
$('tui-mic').addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') stopRec();
  else startRec();
});
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
