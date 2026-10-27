/* ============================================================================
   设计语言：Editorial — 文字即界面

   ══ 立场 ═══════════════════════════════════════════════════════════════════

     界面消失，只剩内容。一切 chrome 都该在你不动的时候隐藏。

   ══ 与 TUI 的差别（同一份 core，两套完全不同的骨架）════════════════════

     TUI                          Editorial
     ─────────────────────────    ─────────────────────────────
     分面板 + 边框 + 状态栏        单栏居中，零边框零面板
     键盘模态（NORMAL/INSERT）     直接打字，没有模式
     选中 = 反色块                 选中 = 文字颜色变化
     等宽 12px / 行高 1.4          衬线 17px / 行高 1.9
     信息密度优先                  阅读节奏优先
     总是显示所有面板              鼠标移动才浮现工具

   ══ 关键实现：输入框不是"框" ═════════════════════════════════════════════

     textarea 无边框无底色，随内容自动增高，与正文同字号同字体同宽度。
     视觉上它就是正文的后半段 —— 这是 Editorial 的灵魂。
   ========================================================================== */

import { boot, DEMO, toEntries } from '../../core/bridge.js';
import { renderMarkdown } from '../../core/markdown.js';
import { createPanel } from '../../core/panel.js';
import { renderSettingsGroup } from '../../core/form.js';
import { SETTINGS_GROUPS, loadValues } from '../../core/settings.js';

const app = boot();
const { client, sessions, stream, history } = app;

document.documentElement.setAttribute('data-theme', app.theme);
document.documentElement.setAttribute('data-palette', app.palette);

/* ═══ 状态 ═══════════════════════════════════════════════════════════════ */
const S = {
  sessionList: [],
  activeSession: null,
  running: false,
  chromeVisible: false,
  pickerOpen: false,
};

/* ═══ DOM 构建 ═══════════════════════════════════════════════════════════ */
const root = document.getElementById('app');
root.className = 'ed';

root.innerHTML = `
  <div class="ed-page">
    <div class="ed-stream" id="ed-stream"></div>

    <div class="ed-composer">
      <textarea id="ed-input" rows="1" placeholder="写点什么…"></textarea>
    </div>

    <div class="ed-foot">
      <span class="ed-status" id="ed-status"></span>
    </div>
  </div>

  <div class="ed-chrome" id="ed-chrome">
    <button class="ed-tool" id="ed-sessions">会话</button>
    <button class="ed-tool" id="ed-look">外观</button>
    <button class="ed-tool" id="ed-settings">设置</button>
    <button class="ed-tool" id="ed-console">控制台</button>
    <span class="ed-tool-sep">·</span>
    <span class="ed-tool-hint">Esc 返回正文</span>
  </div>

  <div class="ed-picker" id="ed-picker" hidden>
    <div class="ed-picker-box" id="ed-picker-box"></div>
  </div>

  <div class="tui-settings" id="ed-settings-panel" hidden>
    <div class="tui-set-box">
      <div class="tui-set-head">
        <span class="tui-set-title">SETTINGS</span>
        <span class="tui-set-toast" id="ed-set-toast"></span>
        <span class="tui-grow"></span>
        <span class="tui-set-close" id="ed-set-close" role="button" tabindex="0">[ 关闭 Esc ]</span>
      </div>
      <div class="tui-set-body">
        <nav class="tui-set-nav" id="ed-set-nav"></nav>
        <div class="tui-set-content" id="ed-set-content"></div>
      </div>
    </div>
  </div>
`;

const $ = (id) => document.getElementById(id);
const streamEl = $('ed-stream');
const inputEl = $('ed-input');
const statusEl = $('ed-status');

/* ═══ 消息渲染：段落流，不是气泡 ═════════════════════════════════════════
   Editorial 里每条消息是一个「段落」，用户段落用斜体+弱色区分。 */
let currentAssistant = null;

function appendPara(kind, text) {
  const p = document.createElement('div');
  p.className = `ed-para ed-para--${kind}`;
  /* 正文走 Markdown；tool 类输出是纯日志，保持原样 */
  if (kind === 'user' || kind === 'assistant') p.innerHTML = renderMarkdown(text);
  else p.textContent = text;
  streamEl.appendChild(p);
  scrollToBottom();
  return p;
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function clearEmpty() {
  const e = streamEl.querySelector('.ed-empty');
  if (e) e.remove();
}

/* ═══ 输入框自动增高 ═════════════════════════════════════════════════════
   让它看起来是正文的延续而不是一个控件。 */
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = inputEl.scrollHeight + 'px';
}

/* ═══ 消息流接线 ═════════════════════════════════════════════════════════ */
stream.handlers.onUserSend = (text) => {
  clearEmpty();
  appendPara('user', text);
  currentAssistant = null;
};

stream.handlers.onAssistantStart = () => {
  currentAssistant = appendPara('assistant', '');
};

stream.handlers.onAssistantDelta = (_d, full) => {
  if (!currentAssistant) currentAssistant = appendPara('assistant', '');
  currentAssistant.innerHTML = renderMarkdown(full);
  scrollToBottom();
};

stream.handlers.onAssistantDone = (text) => {
  if (!currentAssistant) currentAssistant = appendPara('assistant', '');
  currentAssistant.innerHTML = renderMarkdown(text || '');
  currentAssistant = null;
  setStatus('');
};

stream.handlers.onTurnStart = () => setStatus('思考中…');
stream.handlers.onTurnEnd = () => setStatus('');

client.handlers.onOpen = () => {
  if (S.activeSession) setStatus('');
};

/* 拉数据必须等 onReady（ui.connected）—— 在 onOpen 里拉会被静默丢弃。 */
client.handlers.onReady = async () => {
  await loadSessions();
  setStatus(S.sessionList.length ? `${S.sessionList.length} 个会话` : '');
};

client.handlers.onClose = () => setStatus('离线');

function setStatus(t) {
  statusEl.textContent = t;
}

/* ═══ 发送 ═══════════════════════════════════════════════════════════════ */
async function send() {
  const text = inputEl.value.trim();
  if (!text || S.running) return;

  inputEl.value = '';
  autosize();
  S.running = true;

  try {
    await stream.send(text);
  } catch (err) {
    appendPara('error', err?.message || '发送失败');
  } finally {
    S.running = false;
  }
}

/* ═══ 会话数据 ═══════════════════════════════════════════════════════════ */
async function loadSessions() {
  S.sessionList = await sessions.list();
}

/* ═══ chrome 浮现：鼠标移动到顶部/底部，或按 Esc 才出现 ═════════════════
   这是 Editorial 的核心交互 —— 不动鼠标时界面是"裸"的。 */
let hideTimer = null;

function showChrome() {
  root.classList.add('chrome-on');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideChrome, 2400);
}

function hideChrome() {
  if (S.pickerOpen) return;  // 浮层开着时不收
  root.classList.remove('chrome-on');
}

document.addEventListener('mousemove', (e) => {
  if (e.clientY < 90 || e.clientY > window.innerHeight - 90) showChrome();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (S.pickerOpen) { closePicker(); return; }
    hideChrome();
    inputEl.focus();
  }
});

/* ═══ 会话浮层 ═══════════════════════════════════════════════════════════ */
function openPicker(kind) {
  S.pickerOpen = true;
  const box = $('ed-picker-box');
  const picker = $('ed-picker');
  box.innerHTML = '';

  if (kind === 'sessions') {
    const h = document.createElement('div');
    h.className = 'ed-picker-title';
    h.textContent = '会话';
    box.appendChild(h);

    if (!S.sessionList.length) {
      const e = document.createElement('div');
      e.className = 'ed-picker-empty';
      e.textContent = '还没有会话';
      box.appendChild(e);
    }

    for (const s of S.sessionList) {
      const row = document.createElement('button');
      row.className = 'ed-picker-row';
      row.textContent = sessions.titleOf(s);
      row.addEventListener('click', () => {
        openSession(s);
        closePicker();
      });
      box.appendChild(row);
    }

    const nw = document.createElement('button');
    nw.className = 'ed-picker-row ed-picker-new';
    nw.textContent = '＋ 新会话';
    nw.addEventListener('click', () => {
      S.activeSession = null;
      streamEl.innerHTML = '';
      renderEmpty();
      closePicker();
    });
    box.appendChild(nw);
  } else {
    const h = document.createElement('div');
    h.className = 'ed-picker-title';
    h.textContent = '外观';
    box.appendChild(h);

    const themes = [
      ['void', '极简'], ['flow', '流体'], ['focus', '专注'],
      ['console', '终端'], ['reading', '阅读'],
    ];
    const palettes = [
      ['night', '夜'], ['day', '日'], ['sepia', '褐'], ['mono', '单色'], ['forest', '林'],
    ];

    const tLabel = document.createElement('div');
    tLabel.className = 'ed-picker-sub';
    tLabel.textContent = '主题';
    box.appendChild(tLabel);

    const tWrap = document.createElement('div');
    tWrap.className = 'ed-picker-chips';
    for (const [v, label] of themes) {
      const b = document.createElement('button');
      b.className = 'ed-chip';
      b.textContent = label;
      if (document.documentElement.getAttribute('data-theme') === v) b.dataset.on = 'true';
      b.addEventListener('click', () => {
        app.setTheme(v);
        openPicker('look');
      });
      tWrap.appendChild(b);
    }
    box.appendChild(tWrap);

    const pLabel = document.createElement('div');
    pLabel.className = 'ed-picker-sub';
    pLabel.textContent = '配色';
    box.appendChild(pLabel);

    const pWrap = document.createElement('div');
    pWrap.className = 'ed-picker-chips';
    for (const [v, label] of palettes) {
      const b = document.createElement('button');
      b.className = 'ed-chip';
      b.textContent = label;
      if (document.documentElement.getAttribute('data-palette') === v) b.dataset.on = 'true';
      b.addEventListener('click', () => {
        app.setPalette(v);
        openPicker('look');
      });
      pWrap.appendChild(b);
    }
    box.appendChild(pWrap);
  }

  picker.hidden = false;
  showChrome();
}

function closePicker() {
  S.pickerOpen = false;
  $('ed-picker').hidden = true;
  hideChrome();
}

async function openSession(s) {
  S.activeSession = s.id;
  streamEl.innerHTML = "";
  inputEl.focus();

  if (!s.id) return;

  const raw = await history.load(s.id);
  streamEl.innerHTML = "";
  if (!raw.length) {
    const note = document.createElement("div");
    note.className = "ed-empty";
    note.textContent = "这个会话还是空的。";
    streamEl.appendChild(note);
    return;
  }
  // Editorial 只显示正文：工具调用/结果一律不显示（界面消失，只剩文字）
  for (const e of toEntries(raw, { tools: false })) appendPara(e.kind, e.text);
}


/* ═══ 空状态 ═════════════════════════════════════════════════════════════ */
function renderEmpty() {
  streamEl.innerHTML = '';
  const e = document.createElement('div');
  e.className = 'ed-empty';
  e.textContent = '开始写吧。';
  streamEl.appendChild(e);
}

/* ═══ 设置 + 控制台（复用 core，外观走共享 .tui-set-* / .sf-*）════════════════ */
let edSettingsValues = null;
let edSettingsGroupId = null;

function setEdToast(text, ok) {
  const t = $('ed-set-toast');
  t.textContent = text;
  t.className = 'tui-set-toast ' + (ok ? 'is-ok' : 'is-err');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.textContent = ''; t.className = 'tui-set-toast'; }, 1600);
}

function renderEdSetNav() {
  const nav = $('ed-set-nav');
  nav.innerHTML = '';
  for (const g of SETTINGS_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tui-set-navitem' + (g.id === edSettingsGroupId ? ' is-active' : '');
    b.textContent = g.label;
    b.addEventListener('click', () => {
      if (edSettingsGroupId === g.id) return;
      edSettingsGroupId = g.id;
      renderEdSetNav();
      void renderEdSetGroup(g.id);
    });
    nav.appendChild(b);
  }
}

async function renderEdSetGroup(id) {
  const g = SETTINGS_GROUPS.find((x) => x.id === id);
  const content = $('ed-set-content');
  content.innerHTML = '<div class="tui-set-loading">加载…</div>';
  content.scrollTop = 0;
  await renderSettingsGroup(content, {
    group: g,
    values: edSettingsValues,
    app,
    onSaved: (_p, _v, ok) => setEdToast(ok ? '已保存' : '保存失败', ok),
  });
}

async function openEdSettings() {
  closePicker();
  $('ed-settings-panel').hidden = false;
  edSettingsGroupId = edSettingsGroupId || SETTINGS_GROUPS[0].id;
  try {
    if (!edSettingsValues) edSettingsValues = await loadValues(app);
  } catch (err) {
    $('ed-set-content').innerHTML = '<div class="tui-set-loading">读取配置失败，见控制台。</div>';
    console.warn('[editorial] loadValues 失败', err);
    return;
  }
  renderEdSetNav();
  await renderEdSetGroup(edSettingsGroupId);
}

function closeEdSettings() {
  $('ed-settings-panel').hidden = true;
  inputEl.focus();
}
function isEdSettingsOpen() {
  return !$('ed-settings-panel').hidden;
}

/* 控制台浮层（core/panel.js：模型/能力/运行/会话/文件） */
let edPanel = null;
function initEdPanel() {
  edPanel = createPanel(app, {
    reloadSessions: loadSessions,
    getSessions: () => S.sessionList,
    titleOf: (s) => sessions.titleOf(s),
    insertText: (t) => {
      if (edPanel) edPanel.close();
      inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + t;
      inputEl.focus();
      autosize();
    },
  });
}

/* ═══ 事件绑定 ═══════════════════════════════════════════════════════════ */
inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (e) => {
  // Enter 发送，Shift+Enter 换行。isComposing 保护中文输入法。
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

$('ed-sessions').addEventListener('click', () => openPicker('sessions'));
$('ed-look').addEventListener('click', () => openPicker('look'));
$('ed-picker').addEventListener('click', (e) => {
  if (e.target === $('ed-picker')) closePicker();
});

/* 设置浮层关闭 + Esc（浮层/控制台优先于 chrome） */
$('ed-set-close').addEventListener('click', closeEdSettings);
$('ed-set-close').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeEdSettings(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isEdSettingsOpen()) { e.preventDefault(); closeEdSettings(); }
  else if (edPanel && edPanel.isOpen()) { e.preventDefault(); edPanel.close(); }
});

/* ═══ 启动 ═══════════════════════════════════════════════════════════════ */
autosize();
setStatus('');
inputEl.focus();
initEdPanel();
$('ed-settings').addEventListener('click', () => { void openEdSettings(); });
$('ed-console').addEventListener('click', () => { closePicker(); if (edPanel) edPanel.open(); });

if (DEMO.isDemo()) {
  streamEl.innerHTML = '';
  for (const m of DEMO.messages) {
    const p = document.createElement('div');
    p.className = 'ed-para ed-para--' + (m.role === 'user' ? 'user' : 'assistant');
    p.textContent = m.text;
    streamEl.appendChild(p);
  }
  setStatus('demo · 3 会话');
} else {
  renderEmpty();
  client.connect();
}
