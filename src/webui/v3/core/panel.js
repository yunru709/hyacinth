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
    const [active, models] = await Promise.all([app.model.active(), app.model.listModels()]);
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

    // 换模型（点选切换 provider+model；后端 model.switch 是唯一写入口）
    const sec = el('div', 'tui-psec');
    sec.appendChild(el('div', 'tui-psec-h', '换模型（点选切换）'));
    if (!models.length) sec.appendChild(el('div', 'tui-pnote', '（无可用模型目录）'));
    for (const md of models) {
      const isAct = md.provider === a.provider && (!a.model || md.id === a.model);
      const ctx = md.contextWindow ? Math.round(md.contextWindow / 1000) + 'K' : '';
      const row = el('div', 'tui-prow' + (isAct ? ' is-active' : ''));
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(md.name) + '</span>' +
        '<span class="tui-prow-desc">' + esc(md.provider) + (md.reasoning ? ' · 思考' : '') + '</span>' +
        '<span class="tui-prow-meta">' + (isAct ? '使用中' : ctx) + '</span>';
      if (!isAct) {
        row.dataset.clickable = 'true';
        row.addEventListener('click', async () => {
          row.dataset.clickable = 'false';
          const ok = await app.model.switchTo(md.provider, md.id);
          toast(ok ? '已切换到 ' + md.name : '切换失败', ok);
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

  /* 文件区：工作区浏览（HTTP /api/fs/*）。点文件把相对路径插入输入框。 */
  let filesCurPath = '';
  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'K';
    return (n / 1048576).toFixed(1) + 'M';
  }
  async function renderFiles(content) {
    content.innerHTML = '<div class="tui-set-loading">加载…</div>';
    const meta = await app.fs.meta();
    const data = await app.fs.list(filesCurPath);
    if (!data) { content.innerHTML = '<div class="tui-set-loading">无法读取文件列表（/api/fs 不可用）</div>'; return; }
    content.innerHTML = '';

    const bar = el('div', 'tui-toolbar');
    const up = el('button', 'tui-pb2', '↑ 上级');
    up.type = 'button';
    up.disabled = !filesCurPath;
    const crumb = el('span', 'tui-prow-meta', (meta ? meta.name : '工作区') + (filesCurPath ? ' / ' + filesCurPath : ' /'));
    bar.append(up, el('span', 'tui-grow'), crumb);
    content.appendChild(bar);

    const sec = el('div', 'tui-psec');
    const entries = data.entries || [];
    if (!entries.length) sec.appendChild(el('div', 'tui-pnote', '（空目录）'));
    for (const e of entries) {
      const isDir = e.type === 'dir';
      const row = el('div', 'tui-prow');
      row.dataset.clickable = 'true';
      row.innerHTML =
        '<span class="tui-prow-name">' + (isDir ? '▸ ' : '· ') + esc(e.name) + '</span>' +
        '<span class="tui-prow-meta">' + (isDir ? '目录' : fmtSize(e.size)) + '</span>';
      row.addEventListener('click', () => {
        if (isDir) { filesCurPath = e.path; void renderFiles(content); }
        else { void openPreview(e.path, e.name); }
      });
      sec.appendChild(row);
    }
    content.appendChild(sec);

    up.addEventListener('click', () => {
      if (!filesCurPath) return;
      filesCurPath = filesCurPath.includes('/') ? filesCurPath.slice(0, filesCurPath.lastIndexOf('/')) : '';
      void renderFiles(content);
    });
  }

  /* 文件查看器：点文件弹出预览浮层（文本 <pre> 原文 / 图片 / PDF iframe），
     顶部保留「插入路径」把路径塞回输入框。 */
  async function openPreview(filePath, name) {
    const old = document.getElementById('tui-preview');
    if (old) old.remove();
    const pv = document.createElement('div');
    pv.className = 'tui-settings';
    pv.id = 'tui-preview';
    pv.innerHTML =
      '<div class="tui-set-box tui-pv-box">' +
        '<div class="tui-set-head">' +
          '<span class="tui-set-title">' + esc(name || filePath) + '</span>' +
          '<span class="tui-grow"></span>' +
          '<button class="tui-pb2" id="tui-pv-insert" type="button">插入路径</button>' +
          '<span class="tui-set-close" id="tui-pv-close" role="button" tabindex="0">[ 关闭 ]</span>' +
        '</div>' +
        '<div class="tui-set-content" id="tui-pv-body"><div class="tui-set-loading">加载…</div></div>' +
      '</div>';
    document.getElementById('app').appendChild(pv);
    const body = pv.querySelector('#tui-pv-body');
    pv.querySelector('#tui-pv-close').addEventListener('click', () => pv.remove());
    pv.querySelector('#tui-pv-insert').addEventListener('click', () => {
      pv.remove();
      if (hooks.insertText) hooks.insertText(filePath);
    });

    const data = await app.fs.read(filePath);
    if (!data) { body.innerHTML = '<div class="tui-set-loading">无法读取文件内容</div>'; return; }
    const ext = String(data.ext || '').toLowerCase();
    const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
    const isPdf = ext === 'pdf';
    body.innerHTML = '';
    if (data.binary) {
      const rawUrl = '/api/fs/raw?path=' + encodeURIComponent(filePath);
      if (isImg) {
        const img = document.createElement('img');
        img.className = 'tui-pv-img'; img.src = rawUrl; img.alt = name || filePath;
        body.appendChild(img);
      } else if (isPdf) {
        const ifr = document.createElement('iframe');
        ifr.className = 'tui-pv-frame'; ifr.src = rawUrl;
        body.appendChild(ifr);
      } else {
        body.innerHTML = '<div class="tui-set-loading">二进制文件，无法预览</div>';
      }
    } else {
      const meta = document.createElement('div');
      meta.className = 'tui-pnote';
      meta.textContent = (data.kind || 'text') + (data.lang ? ' · ' + data.lang : '') + ' · ' + (data.content || '').split('\n').length + ' 行';
      const pre = document.createElement('pre');
      pre.className = 'tui-pv-pre';
      pre.textContent = data.content || '';
      body.append(meta, pre);
    }
  }

  /* ── 语音：STT 模型下载/删除 + TTS 引擎/模型/Python/服务（对齐 v1 设置页那份）── */
  function pollStt(content) {
    const tick = async () => {
      if (!content.querySelector('[data-voice-root]')) return; // 已切走该区，停
      const s = await app.voice.sttStatus();
      if (!s) return;
      const bar = content.querySelector('.stt-progbar');
      const inner = bar && bar.querySelector('.tui-prog-bar');
      const label = bar && bar.querySelector('.tui-prog-label');
      if (s.downloading) {
        const p = s.downloadProgress;
        const pct = p ? (p.percent || 0) : 0;
        if (bar) {
          bar.hidden = false;
          if (inner) inner.style.width = pct + '%';
          if (label) label.textContent = p ? (pct + '% · ' + (p.speed || '')) : '准备中…';
        }
        setTimeout(tick, 900);
      } else {
        if (bar) bar.hidden = true;
        toast(s.modelReady ? 'STT 模型就绪' : 'STT 下载结束', !!s.modelReady);
        void renderVoice(content);
      }
    };
    setTimeout(tick, 600);
  }
  function pollTts(content) {
    const tick = async () => {
      if (!content.querySelector('[data-voice-root]')) return;
      const t = await app.voice.ttsStatus();
      if (!t) return;
      const bar = content.querySelector('.tts-progbar');
      const inner = bar && bar.querySelector('.tui-prog-bar');
      const label = bar && bar.querySelector('.tui-prog-label');
      const m = t.model || {};
      if (m.downloading) {
        const p = m.downloadProgress;
        const pct = p ? (p.percent || 0) : 0;
        if (bar) {
          bar.hidden = false;
          if (inner) inner.style.width = pct + '%';
          if (label) label.textContent = p ? (pct + '% · ' + (p.speed || '')) : '准备中…';
        }
        setTimeout(tick, 900);
      } else {
        if (bar) bar.hidden = true;
        toast(m.ready ? 'TTS 模型就绪' : 'TTS 下载结束', !!m.ready);
        void renderVoice(content);
      }
    };
    setTimeout(tick, 600);
  }

  async function renderVoice(content) {
    content.innerHTML = '<div class="tui-set-loading">加载…</div>';
    const [stt, tts, eng, sttEnabled, sayBroadcast] = await Promise.all([
      app.voice.sttStatus(), app.voice.ttsStatus(), app.voice.ttsEngines(),
      app.config.get('stt.enabled').catch(() => true),
      app.config.get('voice.say.broadcast').catch(() => true),
    ]);
    content.innerHTML = '';
    const root = el('div');
    root.dataset.voiceRoot = '1';

    // 复用的「启用」开关行（读/写 config）
    function toggleRow(label, hint, checked, save) {
      const row = el('div', 'tui-prow');
      const meta = el('span', 'tui-prow-meta', checked ? '已启用' : '已停用');
      const sw = document.createElement('input');
      sw.type = 'checkbox'; sw.className = 'tui-sw'; sw.checked = checked;
      if (hint) row.title = hint;
      sw.addEventListener('change', async () => {
        const ok = await save(sw.checked);
        if (!ok) { sw.checked = !sw.checked; toast('保存失败', false); return; }
        meta.textContent = sw.checked ? '已启用' : '已停用';
        toast(label + (sw.checked ? ' 已开启' : ' 已关闭'), true);
      });
      row.append(el('span', 'tui-prow-name', label), el('span', 'tui-grow'), meta, sw);
      return row;
    }

    /* ── STT（语音输入）── */
    const s1 = el('div', 'tui-psec');
    s1.appendChild(el('div', 'tui-psec-h', '语音输入（STT）'));
    s1.appendChild(toggleRow('启用语音输入', '开启后输入区出现麦克风，录音转文字。', sttEnabled !== false,
      (v) => app.config.set('stt.enabled', v)));
    const sttState = !stt ? '不可用'
      : stt.modelReady ? '已就绪'
      : stt.downloading ? '下载中…'
      : stt.runtimeAvailable ? '未下载' : '运行时不可用';
    const sttCard = el('div', 'tui-pcard');
    sttCard.innerHTML =
      '<div class="tui-pcard-h">SenseVoice 模型</div>' +
      cardRow('状态', sttState) +
      cardRow('引擎', stt ? stt.engine : '—') +
      cardRow('目录', stt ? stt.modelDir : '—');
    s1.appendChild(sttCard);
    const sttBar = el('div', 'tui-toolbar');
    const sttDl = el('button', 'tui-pb2', '下载模型');
    const sttRm = el('button', 'tui-pbtn', '删除模型');
    sttDl.type = 'button'; sttRm.type = 'button';
    sttDl.disabled = !stt || !stt.runtimeAvailable || stt.modelReady || stt.downloading;
    sttRm.disabled = !stt || !stt.modelReady || stt.downloading;
    const sttProg = el('div', 'tui-prog stt-progbar');
    sttProg.hidden = true;
    sttProg.innerHTML = '<div class="tui-prog-bar"></div><span class="tui-prog-label"></span>';
    sttBar.append(sttDl, sttRm, el('span', 'tui-grow'), sttProg);
    s1.appendChild(sttBar);
    sttDl.addEventListener('click', async () => {
      sttDl.disabled = true; sttProg.textContent = '准备中…';
      try { await app.voice.sttDownload(); } catch (e) { toast('触发下载失败', false); }
      pollStt(content);
    });
    sttRm.addEventListener('click', async () => {
      if (!confirm('删除已下载的语音识别模型？可随时重新下载。')) return;
      await app.voice.sttRemove();
      toast('已删除', true);
      void renderVoice(content);
    });
    if (stt && stt.downloading) pollStt(content);
    root.appendChild(s1);

    /* ── TTS（语音播报）── */
    const s2 = el('div', 'tui-psec');
    s2.appendChild(el('div', 'tui-psec-h', '语音播报（TTS）'));
    s2.appendChild(toggleRow('启用语音播报', '助手回复完成后自动朗读。', sayBroadcast !== false,
      (v) => app.config.set('voice.say.broadcast', v)));
    const eCard = el('div', 'tui-pcard');
    eCard.innerHTML = '<div class="tui-pcard-h">引擎（点选切换）</div>';
    for (const en of (eng && eng.engines) || []) {
      const row = el('div', 'tui-prow' + (en.active ? ' is-active' : ''));
      row.innerHTML =
        '<span class="tui-prow-name">' + esc(en.label) + '</span>' +
        '<span class="tui-prow-meta">' + (en.ready ? '就绪' : '未就绪') + (en.active ? ' · 使用中' : '') + '</span>';
      if (!en.active) {
        row.dataset.clickable = 'true';
        row.addEventListener('click', async () => {
          const ok = await app.voice.setEngine(en.kind);
          toast(ok ? '已切换到 ' + en.label : '切换失败', ok);
          if (ok) void renderVoice(content);
        });
      }
      eCard.appendChild(row);
    }
    s2.appendChild(eCard);

    /* 环境卡跟随「当前活跃引擎」，不再写死 CosyVoice3（孑遗 2026-10-27 指出的矛盾） */
    const activeId = eng && eng.active;
    const activeEn = ((eng && eng.engines) || []).find((e) => e.active) || {};
    const m = (tts && tts.model) || {};
    const py = tts && tts.python;
    const svc = (tts && tts.service) || {};
    const envCard = el('div', 'tui-pcard');
    const bar = el('div', 'tui-toolbar');
    const prog = el('div', 'tui-prog tts-progbar');
    prog.hidden = true;
    prog.innerHTML = '<div class="tui-prog-bar"></div><span class="tui-prog-label"></span>';

    if (activeId === 'cosyvoice3') {
      envCard.innerHTML =
        '<div class="tui-pcard-h">CosyVoice3 环境（本地 Python）</div>' +
        cardRow('模型', m.ready ? '已就绪' : m.downloading ? '下载中…' : '未下载') +
        cardRow('目录', m.modelDir || '—') +
        cardRow('Python', !py ? '未检测' : py.pythonAvailable ? '可用' + (py.cosyvoiceInstalled ? ' · 依赖已装' : ' · 依赖缺失') : '不可用') +
        cardRow('推理服务', svc.running ? '运行中 · ' + svc.port : '未启动');
      const pyBtn = el('button', 'tui-pb2', '检测 Python'); pyBtn.type = 'button';
      const dlBtn = el('button', 'tui-pb2', '下载模型'); dlBtn.type = 'button';
      const startBtn = el('button', 'tui-pb2', '启动服务'); startBtn.type = 'button';
      const stopBtn = el('button', 'tui-pb2', '停止服务'); stopBtn.type = 'button';
      dlBtn.disabled = !!m.ready || !!m.downloading;
      startBtn.disabled = !!svc.running;
      stopBtn.disabled = !svc.running;
      pyBtn.addEventListener('click', async () => { pyBtn.disabled = true; toast('检测 Python 环境中…', true); const r = await app.voice.ttsDetectPython(); toast(r ? '检测完成' : '检测失败', !!r); void renderVoice(content); });
      dlBtn.addEventListener('click', async () => { dlBtn.disabled = true; prog.textContent = '准备中…'; try { await app.voice.ttsDownload(); } catch (e) { toast('触发下载失败', false); } pollTts(content); });
      startBtn.addEventListener('click', async () => { toast('启动推理服务…', true); const r = await app.voice.ttsStart(); toast(r ? '已请求启动' : '启动失败', !!r); void renderVoice(content); });
      stopBtn.addEventListener('click', async () => { await app.voice.ttsStop(); toast('已停止', true); void renderVoice(content); });
      bar.append(pyBtn, dlBtn, startBtn, stopBtn, el('span', 'tui-grow'), prog);
      if (m.downloading) pollTts(content);
    } else if (activeId === 'breeze-tts-2') {
      envCard.innerHTML =
        '<div class="tui-pcard-h">BreezeTTS2 环境（本地 GGUF）</div>' +
        cardRow('状态', activeEn.ready ? '服务就绪' : '未就绪') +
        cardRow('详情', activeEn.detail || '—');
      const startBtn = el('button', 'tui-pb2', '启动服务'); startBtn.type = 'button';
      const stopBtn = el('button', 'tui-pb2', '停止服务'); stopBtn.type = 'button';
      startBtn.disabled = !!activeEn.ready;
      stopBtn.disabled = !activeEn.ready;
      startBtn.addEventListener('click', async () => { toast('启动 BreezeTTS2…', true); const r = await app.voice.ttsBreezeStart(); toast(r ? '已请求启动' : '启动失败', !!r); setTimeout(() => void renderVoice(content), 800); });
      stopBtn.addEventListener('click', async () => { await app.voice.ttsBreezeStop(); toast('已停止', true); setTimeout(() => void renderVoice(content), 500); });
      bar.append(startBtn, stopBtn, el('span', 'tui-grow'), prog);
    } else {
      envCard.innerHTML =
        '<div class="tui-pcard-h">' + esc(activeEn.label || '在线 API 引擎') + '</div>' +
        cardRow('状态', activeEn.ready ? '就绪' : '未就绪') +
        cardRow('详情', activeEn.detail || '—') +
        cardRow('配置', '在「设置 → 语音」填写 API Key / 端点');
    }
    s2.appendChild(envCard);
    if (bar.childElementCount) s2.appendChild(bar);
    // 试听：走当前引擎合成（tts.synthesize → WAV base64 → 播放）
    const testBar = el('div', 'tui-toolbar');
    const testInput = document.createElement('input');
    testInput.type = 'text';
    testInput.className = 'tui-test-input';
    testInput.placeholder = '试听文本';
    testInput.value = '你好，这是语音合成试听。';
    const testBtn = el('button', 'tui-pb2', '试听');
    testBtn.type = 'button';
    testBar.append(testInput, testBtn);
    s2.appendChild(testBar);
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      toast('合成中…', true);
      try {
        const res = await app.voice.synthesize(testInput.value || '你好');
        const b64 = typeof res === 'string' ? res : (res && res.audioWavBase64);
        if (!b64) {
          toast('无音频返回', false);
        } else {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
          await audio.play();
        }
      } catch (e) {
        toast('试听失败', false);
      }
      testBtn.disabled = false;
    });
    root.appendChild(s2);

    content.appendChild(root);
  }

  const SECTION_DEFS = [
    { id: 'model', label: '模型', render: renderModel },
    { id: 'caps', label: '能力', render: renderCaps },
    { id: 'runtime', label: '运行', render: renderRuntime },
    { id: 'voice', label: '语音', render: renderVoice },
    { id: 'sessions', label: '会话', render: renderSessions },
    { id: 'files', label: '文件', render: renderFiles },
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
