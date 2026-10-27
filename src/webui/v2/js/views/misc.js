/* ============================================================================
   Hyacinth WebUI v2 — 会话 / 技能 / 插件 / 定时 / 设置 视图

   这五个视图结构简单（列表 + 开关/删除），合并到一个文件里，
   避免为几十行代码各开一个文件。体量真的涨上来了再拆。
   ========================================================================== */

import { client, go } from '../main.js';
import { appState } from '../main.js';
import { pageShell, section, row, placeholder, h } from './_layout.js';

/* ═══ 会话 ═══════════════════════════════════════════════════════════════ */
let sEls = null;
let sMounted = false;

export const sessionsView = {
  mount(host) {
    sEls = pageShell(host, {
      title: '会话',
      desc: '所有已保存的会话。点开会在对话页新建一个标签。',
    });
    sMounted = true;
  },
  refresh() { if (sMounted) loadSessions(); },
};

async function loadSessions() {
  sEls.body.innerHTML = '';
  sEls.body.appendChild(placeholder('loading', '读取会话…'));

  let list = [];
  try {
    const res = await client.request('session.list', {});
    list = res?.sessions || res || [];
  } catch (err) {
    sEls.body.innerHTML = '';
    sEls.body.appendChild(placeholder('error', err.message));
    return;
  }

  sEls.body.innerHTML = '';

  if (!Array.isArray(list) || list.length === 0) {
    sEls.body.appendChild(placeholder('empty', '还没有保存的会话'));
    return;
  }

  for (const s of list) {
    const btn = h('button', {
      class: 'c-btn c-btn--ghost',
      text: '打开',
      onclick: () => { location.hash = '#/chat'; },
    });
    row(sEls.body, {
      title: s.title || s.id,
      desc: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : (s.type || ''),
      control: btn,
    });
  }
}

/* ═══ 技能 ═══════════════════════════════════════════════════════════════ */
let kEls = null;
let kMounted = false;

export const skillsView = {
  mount(host) {
    kEls = pageShell(host, {
      title: '技能',
      desc: '可被 agent 调用的技能包。关闭后本轮不再注入。',
    });
    kMounted = true;
  },
  refresh() { if (kMounted) loadSkills(); },
};

async function loadSkills() {
  kEls.body.innerHTML = '';
  kEls.body.appendChild(placeholder('loading', '读取技能…'));

  let list = [];
  try {
    const res = await client.request('skill.list', {});
    list = res?.skills || res || [];
  } catch (err) {
    kEls.body.innerHTML = '';
    kEls.body.appendChild(placeholder('error', err.message));
    return;
  }

  kEls.body.innerHTML = '';

  if (!Array.isArray(list) || list.length === 0) {
    kEls.body.appendChild(placeholder('empty', '没有可用技能'));
    return;
  }

  for (const s of list) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = s.enabled !== false;
    cb.addEventListener('change', async () => {
      try {
        await client.request('skill.toggle', { name: s.name, enabled: cb.checked });
      } catch (err) {
        cb.checked = !cb.checked;
        alert(err.message);
      }
    });

    const wrap = h('label', { class: 'c-switch' }, [
      cb,
      h('span', { class: 'c-switch-track' }),
    ]);

    row(kEls.body, {
      title: s.name || s.id,
      desc: s.description || '',
      control: wrap,
    });
  }
}

/* ═══ 插件 ═══════════════════════════════════════════════════════════════ */
let pEls = null;
let pMounted = false;

export const pluginsView = {
  mount(host) {
    pEls = pageShell(host, {
      title: '插件',
      desc: '已安装的插件与它们提供的工具。',
    });
    pMounted = true;
  },
  refresh() { if (pMounted) loadPlugins(); },
};

async function loadPlugins() {
  pEls.body.innerHTML = '';
  pEls.body.appendChild(placeholder('loading', '读取插件…'));

  let list = [];
  try {
    const res = await client.request('plugin.list', {});
    list = res?.plugins || res || [];
  } catch (err) {
    pEls.body.innerHTML = '';
    pEls.body.appendChild(placeholder('error', err.message));
    return;
  }

  pEls.body.innerHTML = '';

  if (!Array.isArray(list) || list.length === 0) {
    pEls.body.appendChild(placeholder('empty', '没有已启用的插件'));
    return;
  }

  for (const p of list) {
    row(pEls.body, {
      title: p.name || p.id,
      desc: [p.version && `v${p.version}`, p.description].filter(Boolean).join(' · '),
      control: h('span', {
        class: 'c-badge' + (p.enabled === false ? '' : ' c-badge--ok'),
        text: p.enabled === false ? '未启用' : '启用中',
      }),
    });
  }
}

/* ═══ 定时任务 ═══════════════════════════════════════════════════════════ */
let tEls = null;
let tMounted = false;

export const scheduleView = {
  mount(host) {
    tEls = pageShell(host, {
      title: '定时任务',
      desc: '在指定时间自动开始一轮对话。',
    });
    tMounted = true;
  },
  refresh() { if (tMounted) loadSchedule(); },
};

async function loadSchedule() {
  tEls.body.innerHTML = '';
  tEls.body.appendChild(placeholder('loading', '读取定时任务…'));

  let list = [];
  try {
    const res = await client.request('schedule.list', {});
    list = res?.tasks || res?.schedules || res || [];
  } catch (err) {
    tEls.body.innerHTML = '';
    tEls.body.appendChild(placeholder('error', err.message));
    return;
  }

  tEls.body.innerHTML = '';

  if (!Array.isArray(list) || list.length === 0) {
    tEls.body.appendChild(placeholder('empty', '还没有定时任务'));
    return;
  }

  for (const t of list) {
    const del = h('button', {
      class: 'c-btn c-btn--danger',
      text: '删除',
      onclick: async () => {
        if (!confirm(`删除定时任务「${t.name || t.id}」？`)) return;
        try {
          await client.request('schedule.remove', { id: t.id });
          loadSchedule();
        } catch (err) { alert(err.message); }
      },
    });
    row(tEls.body, {
      title: t.name || t.id,
      desc: t.when || t.cron || t.nextRun || '',
      control: del,
    });
  }
}

/* ═══ 设置 ═══════════════════════════════════════════════════════════════
   v1 把 20 个配置卡片塞进一页 1226 行，滚动很长且分组随意。
   v2 拆成左侧分类 + 右侧内容，每类一个分区，按「用户在想什么」分组：
     模型与生成 / 上下文与压缩 / 工具与权限 / 外观 / 系统
   ─────────────────────────────────────────────────────────────────────── */
const SETTINGS_GROUPS = [
  { id: 'model',    label: '模型与生成' },
  { id: 'context',  label: '上下文与压缩' },
  { id: 'tools',    label: '工具与权限' },
  { id: 'look',     label: '外观' },
  { id: 'system',   label: '系统' },
];

let gEls = null;
let gMounted = false;
let gCurrent = 'model';

export const settingsView = {
  mount(host) {
    host.innerHTML = '';

    const layout = h('div', { class: 'settings-layout' });
    const nav = h('nav', { class: 'settings-nav' });
    const body = h('div', { class: 'settings-body' });

    for (const g of SETTINGS_GROUPS) {
      const b = h('button', {
        class: 'set-nav-item' + (g.id === gCurrent ? ' is-active' : ''),
        text: g.label,
        onclick: () => {
          gCurrent = g.id;
          for (const x of nav.children) x.classList.toggle('is-active', x.textContent === g.label);
          renderGroup(body);
        },
      });
      nav.appendChild(b);
    }

    layout.append(nav, body);
    host.appendChild(layout);

    gEls = { layout, nav, body };
    gMounted = true;
    renderGroup(body);
  },
  refresh() {},
};

function renderGroup(body) {
  body.innerHTML = '';
  const page = h('div', { class: 'page' });
  const inner = h('div', { class: 'page-inner' });
  page.appendChild(inner);
  body.appendChild(page);

  inner.appendChild(h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title', text: SETTINGS_GROUPS.find((g) => g.id === gCurrent).label }),
  ]));

  const sec = section(inner, {
    title: '正在读取',
    desc: '配置项由后端 schema 驱动，v2 只负责呈现。',
  });
  sec.appendChild(placeholder('loading', '加载配置…'));

  // 真实的配置读取在下一步接：先用 config.getAll 把分组喂进来
  loadConfigGroup(sec, gCurrent);
}

async function loadConfigGroup(slot, group) {
  try {
    const res = await client.request('config.getAll', {});
    const all = res?.config || res || {};
    slot.parentElement.innerHTML = '';

    const entries = flatten(all).filter((e) => matchGroup(e.key, group));

    if (entries.length === 0) {
      slot.parentElement.appendChild(placeholder('empty', '这一类暂时没有可调项'));
      return;
    }

    const body = section(slot.parentElement, {
      title: '配置项',
      desc: '修改即时生效。',
    });

    for (const e of entries) {
      const input = h('input', { class: 'c-input', value: String(e.value ?? '') });
      input.addEventListener('change', async () => {
        try {
          await client.request('config.set', { key: e.key, value: input.value });
        } catch (err) { alert(err.message); }
      });
      row(body, { title: e.key, desc: '', control: input });
    }
  } catch (err) {
    slot.parentElement.innerHTML = '';
    slot.parentElement.appendChild(placeholder('error', err.message));
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

function matchGroup(key, group) {
  const map = {
    model:    /^(provider|model|kernel\.(temperature|maxOutput|topP|thinking))/,
    context:  /^(kernel\.(maxContext|compress)|context|memory)/,
    tools:    /^(tools|permission|safety|mcp)/,
    look:     /^(ui|theme)/,
    system:   /^(repair|log|schedule|webui)/,
  };
  return map[group]?.test(key) ?? false;
}
