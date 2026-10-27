/* ══════════════════════════════════════════════════════════════════════════
   设置表单渲染 —— 一份结构，三套语言各自用 CSS 决定外观
   ══════════════════════════════════════════════════════════════════════════

   为什么放 core：
     schema 的意义是"加配置项只改一处"。若每个语言还要各自实现控件 DOM 与
     事件绑定，schema 就白设计了。各语言的义务只有 .sf-* 的 CSS。

   对外两个入口：
     renderSettingsGroup(container, opts)  渲染**单个分组** ← 设置页按组切换时用
     renderSettingsForm(container, opts)   渲染全部分组 ← 单页滚到底的场景

   ⚠️ 控件用 `change` 而非 `input`：
      range 若用 input，拖动时每一帧都会 config.set（几十次写盘 + 全进程广播）。
      拖动只更新数字显示，松手（change）才落盘。

   ⚠️ 保存反馈必须**行内**：底部提示条离控件太远，用户改完不知道有没有生效。
      每行右侧留一个 .sf-badge 位，成功后短暂显示「已保存」。
   ══════════════════════════════════════════════════════════════════════════ */

import { resolveOptions, saveValue } from './settings.js';

const FEEDBACK_MS = 1600;

/**
 * 渲染单个分组。
 * @param {HTMLElement} container 挂载点（会被清空）
 * @param {object} opts
 *   group    SETTINGS_GROUPS 里的一项
 *   values   { 'path': value }
 *   app      boot() 返回的 app
 *   onSaved  (path, value, ok) => void
 */
export async function renderSettingsGroup(container, { group, values, app, onSaved }) {
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'sf-group-head';

  const title = document.createElement('h2');
  title.className = 'sf-group-title';
  title.textContent = group.label;

  head.appendChild(title);

  if (group.desc) {
    const desc = document.createElement('p');
    desc.className = 'sf-group-desc';
    desc.textContent = group.desc;
    head.appendChild(desc);
  }

  container.appendChild(head);

  const rows = document.createElement('div');
  rows.className = 'sf-rows';
  container.appendChild(rows);

  for (const item of group.items) {
    rows.appendChild(
      await renderItem(item, values[item.path], app, (path, val, ok) => {
        values[path] = val;
        onSaved?.(path, val, ok);
      }),
    );
  }
}

/** 渲染所有分组（单页场景）。 */
export async function renderSettingsForm(container, opts) {
  container.innerHTML = '';
  for (const group of opts.groups) {
    const sec = document.createElement('section');
    sec.className = 'sf-group';
    container.appendChild(sec);
    await renderSettingsGroup(sec, { ...opts, group });
  }
}

/* ═════════════════════════════════════════════════════════════════════════ */

async function renderItem(item, current, app, afterSave) {
  const row = document.createElement('div');
  row.className = 'sf-item';
  row.dataset.path = item.path;

  /* ── 只读状态行 ── */
  if (item.type === 'status') {
    row.classList.add('sf-item--status');
    const left = document.createElement('div');
    left.className = 'sf-text';
    left.innerHTML =
      `<div class="sf-label">${escapeText(item.label)}</div>` +
      (item.hint ? `<div class="sf-hint">${escapeText(item.hint)}</div>` : '');
    row.appendChild(left);

    const right = document.createElement('div');
    right.className = 'sf-control';
    const pill = document.createElement('span');
    pill.className = 'sf-status';
    pill.textContent = '…';
    right.appendChild(pill);
    row.appendChild(right);

    try {
      const s = await item.load(app);
      pill.textContent = s.text;
      pill.classList.add(s.ok ? 'is-ok' : 'is-off');
    } catch {
      pill.textContent = '未知';
      pill.classList.add('is-off');
    }
    return row;
  }

  /* ── 可编辑行 ── */
  const left = document.createElement('div');
  left.className = 'sf-text';

  const label = document.createElement('label');
  label.className = 'sf-label';
  label.textContent = item.label;
  const inputId = 'sf-' + item.path.replace(/\./g, '-');
  label.htmlFor = inputId;
  left.appendChild(label);

  if (item.hint) {
    const hint = document.createElement('div');
    hint.className = 'sf-hint';
    hint.textContent = item.hint;
    left.appendChild(hint);
  }
  row.appendChild(left);

  const right = document.createElement('div');
  right.className = 'sf-control';

  const badge = document.createElement('span');
  badge.className = 'sf-badge';

  const flash = (ok) => {
    badge.textContent = ok ? '已保存' : '保存失败';
    badge.className = `sf-badge ${ok ? 'is-ok' : 'is-err'}`;
    clearTimeout(badge._t);
    badge._t = setTimeout(() => {
      badge.textContent = '';
      badge.className = 'sf-badge';
    }, FEEDBACK_MS);
  };

  const commit = async (value) => {
    const ok = await saveValue(app, item.path, value);
    flash(ok);
    afterSave(item.path, value, ok);
  };

  switch (item.type) {
    case 'bool': {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'sf-switch';
      input.id = inputId;
      input.checked = !!current;
      input.addEventListener('change', () => commit(input.checked));
      right.appendChild(input);
      break;
    }

    case 'range': {
      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'sf-range';
      input.id = inputId;
      input.min = String(item.min ?? 0);
      input.max = String(item.max ?? 1);
      input.step = String(item.step ?? 0.01);
      input.value = String(current ?? item.min ?? 0);

      const out = document.createElement('span');
      out.className = 'sf-value';
      out.textContent = fmt(input.value);

      input.addEventListener('input', () => { out.textContent = fmt(input.value); });
      input.addEventListener('change', () => commit(Number(input.value)));

      right.append(input, out);
      break;
    }

    case 'number': {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sf-number';
      input.id = inputId;
      if (item.min != null) input.min = String(item.min);
      if (item.max != null) input.max = String(item.max);
      if (item.step != null) input.step = String(item.step);
      input.value = current == null ? '' : String(current);
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (Number.isFinite(n)) commit(n);
      });
      right.appendChild(input);
      break;
    }

    case 'text': {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sf-text-input';
      input.id = inputId;
      input.value = current == null ? '' : String(current);
      input.addEventListener('change', () => commit(input.value));
      right.appendChild(input);
      break;
    }

    case 'select': {
      const sel = document.createElement('select');
      sel.className = 'sf-select';
      sel.id = inputId;
      const opts = await resolveOptions(app, item);
      for (const o of opts) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      if (current != null) sel.value = String(current);
      sel.addEventListener('change', () => commit(sel.value));
      right.appendChild(sel);
      break;
    }

    default:
      break;
  }

  right.appendChild(badge);
  row.appendChild(right);
  return row;
}

/* 去掉末尾多余的 0：0.700 → 0.7，但 1 → 1 */
function fmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Number(n.toFixed(4)));
}

function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
