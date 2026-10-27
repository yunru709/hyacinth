/* ============================================================================
   TUI 控制台浮层 —— 模型 / 能力 / 运行 / 会话

   为什么独立成文件：index.js 已 560+ 行；控制台逻辑自成一体，且只依赖 core 的
   domains（app.model / app.caps / app.runtime / app.sessionAdmin），与主界面耦合
   很小，只用 hooks 拿「会话列表 / 重载 / 标题」。外壳复用 .tui-set-* 浮层样式，
   不新建一套 CSS 骨架。

   数据来源（2026-10-27 实测过的真实结构）：
     model.active()   → {provider, model, providerLabel, isLocal, maxContextTokens}
     model.providers()→ [{type,label,model,active,isLocal,configured,status}] ×16
     caps.skills()    → [{name,description,source,enabled,relatedTools,hasDir}] ×N
     caps.mcpServers()→ [{name,enabled,connected,toolCount,scope,command}] ×N
     caps.toolBundles()→ [{name,description,builtin}] ×16
     caps.plugins()   → [{id,state,deps}] ×N
     runtime.mode()   → {profile, unrestricted, goal}   profile ∈ plan|confirm|auto|full
     runtime.schedules()→ {tasks:[], status:{running,taskCount,…}}
     runtime.processes()→ [{pid, command, …}]
   ========================================================================== */

/* ---- 小工具 ---- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function cardRow(k, v) {
  return '<div class="tui-pcard-row"><span>' + k + '</span><b>' + esc(v) + '</b></div>';
}
function shortId(id) {
  return id ? '…' + String(id).slice(-8) : '新';
}

export function createPanel(app, hooks = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'tui-settings';
  wrap.id = 'tui-panel';
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="tui-set-box">
      <div class="tui-set-head">
        <span class="tui-set-title">控制台</span>
        <span class="tui-set-toast" id="tui-panel-toast"></span>
        <span class="tui-grow"></span>
        <span class="tui-set-close" id="tui-panel-close" role="button" tabindex="0">[ 关闭 Esc ]</span>
      </div>
      <div class="tui-set-body">
        <nav class="tui-set-nav" id="tui-panel-nav"></nav>
        <div class="tui-set-content" id="tui-panel-content"></div>
      </div>
    </div>`;
  document.getElementById('app').appendChild(wrap);

  const navEl = wrap.querySelector('#tui-panel-nav');
  const contentEl = wrap.querySelector('#tui-panel-content');

  function toast(text, ok) {
    const t = wrap.querySelector('#tui-panel-toast');
    t.textContent = text;
    t.className = 'tui-set-toast ' + (ok ? 'is-ok' : 'is-err');
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.textContent = ''; t.className = 'tui-set-toast'; }, 1600);
  }

  /* ---- 各分区渲染 ---- */

  async function renderModel(content) {
    const [active, providers] = await Promise.all([app.model.active(), app.model.providers()]);
    content.innerHTML = '';
    const a = active || {};

    const card = el('div', 'tui-pcard');
    card.innerHTML =
      '<div class="tui-pcard-h">当前模型</div>' +
      cardRow('Provider', a.providerLabel || a.provider || '—') +
      cardRow('模型', a.model || '（默认）') +
      cardRow('上下文', (a.maxContextTokens ? Math.round(a.maxContextTokens / 1000) + 'K' : '—') + (a.isLocal ? ' · 本地' : ' · 云端'));
    content.appendChild(card);

    // 思考档位（6 档，off=关闭思考；仅作用于当前生效模型）
    const THINKING = [['off', '关'], ['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['max', '最高']];
    const tsec = el('div', 'tui-psec');
    tsec.appendChild(el('div', 'tui-psec-h', '思考档位（仅当前模型）'));
    const tseg = el('div', 'tui-seg');
    for (const [val, label] of THINKING) {
      const b = el('button', 'tui-seg-btn', label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        const enabled = val !== 'off';
        const ok = await app.model.setThinking(enabled, enabled ? val : undefined);
        toast(ok ? '思考档位：' + label : '设置失败', ok);
        if (ok) tseg.querySelectorAll('.tui-seg-btn').forEach((x) => x.classList.toggle('is-on', x === b));
      });
      tseg.appendChild(b);
    }
    tsec.appendChild(tseg);
    content.appendChild(tsec);

    const sec = el('div', 'tui-psec');
    sec.appendChild(el('div', 'tui-psec-h', '提供商（点已配置的以切换）'));
    for (const p of providers) {
      const row = el('div', 'tui-prow' + (p.active ? ' is-active' : '') + (p.configured ? '' : ' is-off'));
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(p.label) + '</span>' +
        '<span class="tui-prow-desc">' + esc(p.model || '') + '</span>' +
        '<span class="tui-prow-meta">' + (p.active ? '使用中' : esc(p.status || '')) + '</span>';
      if (p.configured && !p.active) {
        row.dataset.clickable = 'true';
        row.addEventListener('click', async () => {
          row.dataset.clickable = 'false';
          const ok = await app.model.switchTo(p.type, p.model);
          toast(ok ? '已切换到 ' + p.label : '切换失败', ok);
          if (ok) void renderModel(content);
        });
      }
      sec.appendChild(row);
    }
    content.appendChild(sec);
  }

  async function renderCaps(content) {
    const [bundles, skills, mcp, plugins] = await Promise.all([
      app.caps.toolBundles(), app.caps.skills(), app.caps.mcpServers(), app.caps.plugins(),
    ]);
    content.innerHTML = '';

    // 技能（可开关）
    const s1 = el('div', 'tui-psec');
    s1.appendChild(el('div', 'tui-psec-h', '技能（可开关）· ' + skills.length));
    if (!skills.length) s1.appendChild(el('div', 'tui-pnote', '（无）'));
    for (const sk of skills) {
      const row = el('div', 'tui-prow');
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(sk.name) + '</span>' +
        '<span class="tui-prow-desc">' + esc(sk.description || '') + '</span>';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'tui-sw';
      sw.checked = !!sk.enabled;
      sw.addEventListener('change', async () => {
        const ok = await app.caps.toggleSkill(sk.name, sw.checked);
        toast(ok ? sk.name + (sw.checked ? ' 已启用' : ' 已停用') : '操作失败', ok);
        if (!ok) sw.checked = !sw.checked;
      });
      row.appendChild(sw);
      s1.appendChild(row);
    }
    content.appendChild(s1);

    // MCP
    const conn = mcp.filter((m) => m.connected).length;
    const s2 = el('div', 'tui-psec');
    s2.appendChild(el('div', 'tui-psec-h', 'MCP 服务器 · ' + conn + '/' + mcp.length + ' 已连接'));
    if (!mcp.length) s2.appendChild(el('div', 'tui-pnote', '（无）'));
    for (const m of mcp) {
      const row = el('div', 'tui-prow' + (m.connected ? '' : ' is-off'));
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(m.name) + '</span>' +
        '<span class="tui-prow-meta">' + (m.connected ? '已连接' : '未连接') + ' · ' + (m.toolCount || 0) + ' 工具</span>';
      s2.appendChild(row);
    }
    content.appendChild(s2);

    // 工具包（只读概览）
    const s3 = el('div', 'tui-psec');
    s3.appendChild(el('div', 'tui-psec-h', '工具包 · ' + bundles.length));
    for (const b of bundles) {
      const row = el('div', 'tui-prow');
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(b.name) + '</span>' +
        '<span class="tui-prow-desc">' + esc(b.description || '') + '</span>' +
        (b.builtin ? '<span class="tui-prow-meta">内置</span>' : '');
      s3.appendChild(row);
    }
    content.appendChild(s3);

    // 插件（只读）
    const s4 = el('div', 'tui-psec');
    s4.appendChild(el('div', 'tui-psec-h', '插件 · ' + plugins.length));
    for (const p of plugins) {
      const row = el('div', 'tui-prow' + (p.state === 'mounted' ? '' : ' is-off'));
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(p.id) + '</span>' +
        '<span class="tui-prow-meta">' + esc(p.state || '') + '</span>';
      s4.appendChild(row);
    }
    content.appendChild(s4);
  }

  async function renderRuntime(content) {
    const [mode, sch, procs] = await Promise.all([
      app.runtime.mode(), app.runtime.schedules(), app.runtime.processes(),
    ]);
    content.innerHTML = '';

    // 执行档位
    const s1 = el('div', 'tui-psec');
    s1.appendChild(el('div', 'tui-psec-h', '执行档位'));
    const seg = el('div', 'tui-seg');
    const PROFILES = [['plan', '计划'], ['confirm', '确认'], ['auto', '自动'], ['full', '全权']];
    const cur = (mode && mode.profile) || 'confirm';
    for (const [val, label] of PROFILES) {
      const b = el('button', 'tui-seg-btn' + (val === cur ? ' is-on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        const ok = await app.runtime.setProfile(val);
        toast(ok ? '已切换到「' + label + '」档' : '切换失败', ok);
        if (ok) void renderRuntime(content);
      });
      seg.appendChild(b);
    }
    s1.appendChild(seg);
    if (mode && mode.unrestricted) s1.appendChild(el('div', 'tui-pnote', '⚠ 当前 unrestricted（无限制）'));
    content.appendChild(s1);

    // 定时任务
    const st = sch && sch.status;
    const s2 = el('div', 'tui-psec');
    s2.appendChild(el('div', 'tui-psec-h', '定时任务' + (st ? (st.running ? ' · 运行中' : ' · 已停') : '')));
    const tasks = (sch && sch.tasks) || [];
    if (!tasks.length) s2.appendChild(el('div', 'tui-pnote', '（无任务）'));
    for (const t of tasks) {
      const row = el('div', 'tui-prow');
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(t.name || t.id || '—') + '</span>' +
        '<span class="tui-prow-meta">' + esc(t.cron || t.schedule || '') + '</span>';
      s2.appendChild(row);
    }
    content.appendChild(s2);

    // 后台进程
    const s3 = el('div', 'tui-psec');
    s3.appendChild(el('div', 'tui-psec-h', '后台进程 · ' + procs.length));
    if (!procs.length) s3.appendChild(el('div', 'tui-pnote', '（无）'));
    for (const pr of procs) {
      const row = el('div', 'tui-prow');
      const pid = pr.pid || pr.id;
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(String(pid || '—')) + '</span>' +
        '<span class="tui-prow-desc">' + esc(pr.command || pr.cmd || '') + '</span>';
      const kill = el('button', 'tui-pbtn', '结束');
      kill.type = 'button';
      kill.addEventListener('click', async () => {
        if (!confirm('结束进程 ' + pid + ' ？')) return;
        const ok = await app.runtime.killProcess(pid);
        toast(ok ? '已结束' : '结束失败', ok);
        if (ok) void renderRuntime(content);
      });
      row.appendChild(kill);
      s3.appendChild(row);
    }
    content.appendChild(s3);
  }

  async function renderSessions(content) {
    if (hooks.reloadSessions) await hooks.reloadSessions();
    const list = (hooks.getSessions && hooks.getSessions()) || [];
    content.innerHTML = '';

    const s1 = el('div', 'tui-psec');
    s1.appendChild(el('div', 'tui-psec-h', '会话 · ' + list.length + '（删除不可恢复）'));

    // 工具栏：全选 / 选中数 / 导出选中 / 批量删除
    const bar = el('div', 'tui-toolbar');
    const chkAll = document.createElement('input');
    chkAll.type = 'checkbox'; chkAll.className = 'tui-chk'; chkAll.title = '全选';
    const selCount = el('span', 'tui-pnote', '选中 0');
    const btnExp = el('button', 'tui-pb2', '导出选中');
    const btnDel = el('button', 'tui-pbtn', '批量删除');
    btnExp.type = 'button'; btnDel.type = 'button';
    btnExp.disabled = true; btnDel.disabled = true;
    bar.append(chkAll, selCount, el('span', 'tui-grow'), btnExp, btnDel);
    s1.appendChild(bar);

    const selected = () => [...s1.querySelectorAll('.tui-chk[data-sid]:checked')].map((c) => c.dataset.sid);
    function refresh() {
      const n = selected().length;
      selCount.textContent = '选中 ' + n;
      btnExp.disabled = n === 0;
      btnDel.disabled = n === 0;
      chkAll.checked = n > 0 && n === list.length;
    }

    if (!list.length) s1.appendChild(el('div', 'tui-pnote', '（无会话）'));
    for (const s of list) {
      const title = hooks.titleOf ? hooks.titleOf(s) : (s.title || s.id || '—');
      const row = el('div', 'tui-prow');
      const chk = document.createElement('input');
      chk.type = 'checkbox'; chk.className = 'tui-chk'; chk.dataset.sid = s.id || '';
      chk.addEventListener('change', refresh);
      const name = el('span', 'tui-prow-name', title);
      const meta = el('span', 'tui-prow-meta', shortId(s.id));
      const del = el('button', 'tui-pbtn', '删除');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm('删除会话「' + title + '」？此操作不可恢复。')) return;
        const ok = await app.sessionAdmin.remove(s.id);
        toast(ok ? '已删除' : '删除失败', ok);
        if (ok) void renderSessions(content);
      });
      row.append(chk, name, meta, del);
      s1.appendChild(row);
    }

    chkAll.addEventListener('change', () => {
      s1.querySelectorAll('.tui-chk[data-sid]').forEach((c) => { c.checked = chkAll.checked; });
      refresh();
    });

    btnDel.addEventListener('click', async () => {
      const ids = selected();
      if (!ids.length) return;
      if (!confirm('删除选中的 ' + ids.length + ' 个会话？不可恢复。')) return;
      const ok = await app.sessionAdmin.batchRemove(ids);
      toast(ok ? '已删除 ' + ids.length + ' 个' : '批量删除失败', ok);
      if (ok) void renderSessions(content);
    });

    btnExp.addEventListener('click', async () => {
      const ids = selected();
      if (!ids.length) return;
      btnExp.disabled = true;
      try {
        const r = await app.sessionAdmin.exportSessions(ids);
        if (r && r.data) {
          // base64 → Blob → 触发下载
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
          const a = document.createElement('a');
          a.href = url; a.download = r.filename || 'sessions.zip';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
          toast('已导出 ' + (r.count || ids.length) + ' 个会话', true);
        } else {
          toast('导出失败', false);
        }
      } catch (e) {
        toast('导出失败', false);
      } finally {
        btnExp.disabled = false;
      }
    });

    content.appendChild(s1);
    refresh();
  }

  const SECTION_DEFS = [
    { id: 'model', label: '模型', render: renderModel },
    { id: 'caps', label: '能力', render: renderCaps },
    { id: 'runtime', label: '运行', render: renderRuntime },
    { id: 'sessions', label: '会话', render: renderSessions },
  ];
  let currentId = 'model';

  function renderNav() {
    navEl.innerHTML = '';
    for (const sec of SECTION_DEFS) {
      const b = el('button', 'tui-set-navitem' + (sec.id === currentId ? ' is-active' : ''), sec.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (sec.id === currentId) return;
        currentId = sec.id;
        renderNav();
        void renderSection(sec.id);
      });
      navEl.appendChild(b);
    }
  }

  async function renderSection(id) {
    const sec = SECTION_DEFS.find((x) => x.id === id);
    contentEl.innerHTML = '<div class="tui-set-loading">加载…</div>';
    contentEl.scrollTop = 0;
    try {
      await sec.render(contentEl);
    } catch (err) {
      contentEl.innerHTML = '<div class="tui-set-loading">加载失败：' + esc(err && err.message ? err.message : err) + '</div>';
      console.warn('[tui.panel] ' + id + ' 渲染失败', err);
    }
  }

  function open() {
    wrap.hidden = false;
    renderNav();
    void renderSection(currentId);
  }
  function close() { wrap.hidden = true; }
  function isOpen() { return !wrap.hidden; }

  wrap.querySelector('#tui-panel-close').addEventListener('click', close);
  wrap.querySelector('#tui-panel-close').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); }
  });

  return { open, close, isOpen };
}
