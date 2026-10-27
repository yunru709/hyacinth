/* ============================================================================
   Hyacinth WebUI v2 — 视图工厂

   六个内容页（模型/会话/技能/插件/定时/设置）结构高度相似：
     页头 + 若干分区 + 列表/表单。
   与其复制六份骨架，不如抽出工厂 —— 每个视图只声明「拉什么数据、怎么渲染一行」。

   为什么不做成通用「配置驱动 UI」：
     那会把每个视图的差异挤进一堆 if，反而更难读。这里只抽**骨架**，
     每个视图的渲染函数仍然自己写，保持直白。
   ========================================================================== */

/** 内容页骨架：可滚动容器 + 居中内容区 + 页头。 */
export function pageShell(host, { title, desc }) {
  host.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page';

  const inner = document.createElement('div');
  inner.className = 'page-inner';

  const head = document.createElement('div');
  head.className = 'page-head';
  const h1 = document.createElement('h1');
  h1.className = 'page-title';
  h1.textContent = title;
  head.appendChild(h1);
  if (desc) {
    const p = document.createElement('p');
    p.className = 'page-desc';
    p.textContent = desc;
    head.appendChild(p);
  }

  const body = document.createElement('div');
  body.className = 'page-body';

  inner.append(head, body);
  page.appendChild(inner);
  host.appendChild(page);
  return { page, inner, head, body };
}

/** 一个分区：标题 + 说明 + 内容槽。 */
export function section(parent, { title, desc }) {
  const wrap = document.createElement('div');
  wrap.className = 'c-section';

  const head = document.createElement('div');
  head.className = 'c-section-head';
  const h2 = document.createElement('h2');
  h2.className = 'c-section-title';
  h2.textContent = title;
  head.appendChild(h2);
  if (desc) {
    const p = document.createElement('p');
    p.className = 'c-section-desc';
    p.textContent = desc;
    head.appendChild(p);
  }

  const body = document.createElement('div');
  wrap.append(head, body);
  parent.appendChild(wrap);
  return body;
}

/** 一行：左标题/说明 + 右控件。设置页 90% 的项都用这个。 */
export function row(parent, { title, desc, control }) {
  const el = document.createElement('div');
  el.className = 'c-row';

  const main = document.createElement('div');
  main.className = 'c-row-main';
  const t = document.createElement('div');
  t.className = 'c-row-title';
  t.textContent = title;
  main.appendChild(t);
  if (desc) {
    const d = document.createElement('div');
    d.className = 'c-row-desc';
    d.textContent = desc;
    main.appendChild(d);
  }

  const ctrl = document.createElement('div');
  ctrl.className = 'c-row-ctrl';
  if (control) ctrl.appendChild(control);

  el.append(main, ctrl);
  parent.appendChild(el);
  return el;
}

/** 空态 / 加载态 / 错误态的统一样式。 */
export function placeholder(kind, text) {
  const el = document.createElement('div');
  el.className = 'c-empty';
  if (kind === 'loading') {
    const s = document.createElement('span');
    s.className = 'c-loading';
    el.append(s, document.createTextNode(text || '加载中…'));
  } else {
    el.textContent = text || (kind === 'error' ? '加载失败' : '暂无内容');
  }
  return el;
}

/** 小工具：创建元素并设属性，减少样板。 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
