// build-webui-spa — 从桌面 hyacinth-webui 设计稿提取并生成 SPA 骨架
// 输入: C:/Users/74689/Desktop/hyacinth-webui (桌面设计稿)
// 输出: src/webui/index.html + src/webui/theme.css + src/webui/app.css
// 一次性迁移工具，可重复运行（幂等覆盖）。
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/74689/Desktop/hyacinth-webui';
const PAGES = path.join(SRC, 'pages');
const OUT = path.join(process.cwd(), 'src', 'webui');

function read(name) {
  return fs.readFileSync(path.join(PAGES, name), 'utf8');
}

// ── 提取共享 shell（header + sidebar），来自 index.html ──────────────
function extractShell(html) {
  // 从 <div ... id="app-shell"> 到 <main id="hyacinth-main" 之前
  const startIdx = html.indexOf('<div class="h-screen w-screen overflow-hidden flex flex-col bg-background text-foreground" id="app-shell"');
  const mainIdx = html.indexOf('<main id="hyacinth-main"');
  if (startIdx < 0 || mainIdx < 0) throw new Error('shell 边界未找到');
  return html.slice(startIdx, mainIdx);
}

// ── 提取视图 main 内容（不含 main 标签本身）──────────────────────────
function extractView(html) {
  const m = html.match(/<main[^>]*id="hyacinth-main"[^>]*>([\s\S]*?)<\/main>/);
  if (!m) throw new Error('main 未找到');
  return m[1];
}

// ── 提取 companion body 内容（全屏，无 shell）────────────────────────
function extractCompanion(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!m) throw new Error('companion body 未找到');
  return m[1];
}

// ── 提取各页 critical-layout + 额外样式（<style> 块合并去重）──────────
function extractStyles(html) {
  const styles = [];
  const re = /<style[^>]*id="critical-layout"[^>]*>([\s\S]*?)<\/style>/g;
  let mm;
  while ((mm = re.exec(html))) styles.push(mm[1]);
  // 额外样式（排除 theme-vars / semantic / critical / text/tailwindcss）
  const re2 = /<style(?![^>]*id="(theme-vars|semantic-token-fallback|critical-layout)")(?![^>]*type="text\/tailwindcss")[^>]*>([\s\S]*?)<\/style>/g;
  while ((mm = re2.exec(html))) styles.push(mm[2]);
  return styles;
}

// ── 提取 text/tailwindcss 配置块（Tailwind 浏览器运行时消费）───────────
function extractTailwindConfig(html) {
  const m = html.match(/<style type="text\/tailwindcss">([\s\S]*?)<\/style>/);
  return m ? m[1].trim() : '';
}

// ── 提取 semantic-token-fallback（CSS 变量 → 工具类映射，防 Tailwind 未生成时白屏）──
function extractSemanticFallback(html) {
  const m = html.match(/<style[^>]*id="semantic-token-fallback"[^>]*>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}

function main() {
  const indexHtml = read('index.html');
  const modelHtml = read('model.html');
  const sessionsHtml = read('sessions.html');
  const settingsHtml = read('settings.html');
  const companionHtml = read('companion.html');

  // 1. 共享 shell（来自 index.html），导航改 hash 路由
  let shell = extractShell(indexHtml);
  shell = shell
    .replace(/href="companion\.html"/g, 'href="#/companion"')
    .replace(/href="model\.html"/g, 'href="#/model"')
    .replace(/href="sessions\.html"/g, 'href="#/sessions"')
    .replace(/href="settings\.html"/g, 'href="#/settings"')
    .replace(/href="index\.html"/g, 'href="#/chat"')
    .replace(/href="#"/g, 'href="#/chat"');

  // 2. 各视图内容
  const chatView = extractView(indexHtml);
  const modelView = extractView(modelHtml);
  const sessionsView = extractView(sessionsHtml);
  const settingsView = extractView(settingsHtml);
  const companionView = extractCompanion(companionHtml);

  // 3. 收集所有样式（去重）+ semantic fallback
  const allStyles = [
    ...extractStyles(indexHtml),
    ...extractStyles(modelHtml),
    ...extractStyles(sessionsHtml),
    ...extractStyles(settingsHtml),
  ];
  const uniqueStyles = Array.from(new Set(allStyles)).join('\n\n');
  const semanticFallback = extractSemanticFallback(indexHtml);

  // 4. 复制 assets 目录（供 ../assets/ 引用）
  const assetsSrc = path.join(SRC, 'assets');
  const assetsDst = path.join(OUT, 'assets');
  if (fs.existsSync(assetsSrc)) {
    fs.mkdirSync(assetsDst, { recursive: true });
    for (const f of fs.readdirSync(assetsSrc)) {
      fs.copyFileSync(path.join(assetsSrc, f), path.join(assetsDst, f));
    }
    console.log('assets 已复制:', fs.readdirSync(assetsSrc).join(', '));
  }

  // 4. 生成 index.html（../assets/ → assets/，因 assets 已复制到 webui 根下）
  const tailwindCfg = extractTailwindConfig(indexHtml);
  const spa = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hyacinth WebUI</title>
  <link rel="icon" type="image/svg+xml" href="/assets/concept-art.svg">
  <link rel="stylesheet" href="/theme.css">
  <script src="/vendor/tailwind-browser.js"></script>
  <script src="/vendor/lucide.min.js"></script>
  <link rel="stylesheet" href="/app.css">
  <style type="text/tailwindcss">
${tailwindCfg}
  </style>
</head>
<body class="h-screen w-screen overflow-hidden font-sans antialiased">
${shell}
    <main id="hyacinth-main" data-nav-key="main" class="flex-1 overflow-hidden relative bg-background">
      <section data-view="chat" class="view-section h-full">${chatView}</section>
      <section data-view="model" class="view-section h-full" hidden>${modelView}</section>
      <section data-view="sessions" class="view-section h-full" hidden>${sessionsView}</section>
      <section data-view="settings" class="view-section h-full" hidden>${settingsView}</section>
    </main>
  </div>
</div>
  <section data-view="companion" class="view-section companion-view" hidden>${companionView}</section>

  <!-- 工具权限对话框（协议 permission.request / resolve） -->
  <div id="permission-dialog" class="cmd-overlay" hidden>
    <div class="cmd-box permission-box">
      <h4 class="text-sm font-semibold text-foreground">工具权限请求</h4>
      <p id="permission-text" class="text-xs text-muted-foreground"></p>
      <div class="permission-actions">
        <button data-perm="always" class="dialog-btn">始终允许</button>
        <button data-perm="yes" class="dialog-btn">允许一次</button>
        <button data-perm="no" class="dialog-btn">拒绝</button>
      </div>
    </div>
  </div>

  <!-- ask_user 表单对话框（协议 message.ask_user / askUserResolve） -->
  <div id="askuser-dialog" class="cmd-overlay" hidden>
    <div class="cmd-box askuser-box">
      <h4 class="text-sm font-semibold text-foreground">请回答问题</h4>
      <div id="askuser-questions"></div>
      <div class="permission-actions">
        <button id="askuser-submit" class="dialog-btn">提交</button>
      </div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>`
  // 归一化资源路径 + 残留页面链接 → hash
  .replace(/\.\.\/assets\//g, 'assets/')
  .replace(/href="model\.html"/g, 'href="#/model"')
  .replace(/href="index\.html"/g, 'href="#/chat"')
  .replace(/href="sessions\.html"/g, 'href="#/sessions"')
  .replace(/href="settings\.html"/g, 'href="#/settings"')
  // 注入共享 shell 状态 id（供 app.js 更新 header）
  .replace(
    '<span class="text-xs font-medium truncate max-w-[180px]">claude-3-5-sonnet</span>',
    '<span id="header-model-name" class="text-xs font-medium truncate max-w-[180px]">claude-3-5-sonnet</span>'
  )
  .replace(
    '<span class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">Anthropic</span>',
    '<span id="header-model-provider" class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">Anthropic</span>'
  )
  .replace(
    '<div class="h-full bg-primary" style="width: 42%"></div>',
    '<div id="header-context-bar" class="h-full bg-primary" style="width: 42%"></div>'
  )
  .replace(
    '<span class="text-xs font-mono text-muted-foreground whitespace-nowrap">12.4k / 200k</span>',
    '<span id="header-context-text" class="text-xs font-mono text-muted-foreground whitespace-nowrap">12.4k / 200k</span>'
  )
  .replace(
    '<span class="w-1.5 h-1.5 rounded-full bg-state-success"></span>',
    '<span id="header-online-dot" class="w-1.5 h-1.5 rounded-full bg-state-success"></span>'
  )
  .replace(
    '<span>Hyacinth v0.4.0</span>',
    '<span id="sidebar-version">Hyacinth v0.4.0</span>'
  )
  // 注入 chat composer 可靠 id（发送按钮/输入框）
  .replace(
    'placeholder="输入消息…"',
    'id="chat-input" placeholder="输入消息…"'
  )
  .replace(
    '<button class="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity">\n              <i data-lucide="send-horizontal" class="w-4 h-4"></i>',
    '<button id="chat-send-btn" class="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity">\n              <i data-lucide="send-horizontal" class="w-4 h-4"></i>'
  )
  .replace(
    '<button id="chat-attach-btn" class="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors" aria-label="附加文件">',
    '<button id="chat-attach-btn" class="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors" aria-label="附加文件">'
  )
  .replace(
    '<button class="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity" aria-label="发送">',
    '<button id="chat-send-btn" class="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity" aria-label="发送">'
  )
  // 注入 stop 按钮（发送后显示，message.stop 用）
  .replace(
    '<button id="chat-send-btn" class="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity" aria-label="发送">\n                <i data-lucide="send-horizontal" class="w-4 h-4"></i>\n              </button>',
    '<button id="chat-send-btn" class="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity" aria-label="发送">\n                <i data-lucide="send-horizontal" class="w-4 h-4"></i>\n              </button>\n              <button id="chat-stop-btn" class="p-1.5 rounded-md bg-muted text-muted-foreground hover:bg-muted/70 transition-opacity" aria-label="停止" hidden>\n                <i data-lucide="square" class="w-4 h-4"></i>\n              </button>'
  )
  // 注入 model 视图数据绑定 id（当前启用卡片 / provider-grid / 推理强度 / Ollama / 本地模型 / 添加密钥）
  .replace(
    '<span class="text-lg font-semibold text-foreground">Claude 3.5 Sonnet</span>',
    '<span id="model-active-name" class="text-lg font-semibold text-foreground">Claude 3.5 Sonnet</span>'
  )
  .replace(
    '<span class="text-xs text-muted-foreground">via Anthropic</span>',
    '<span id="model-active-via" class="text-xs text-muted-foreground">via Anthropic</span>'
  )
  .replace(
    '<span class="font-mono">claude-3-5-sonnet-20241022</span>',
    '<span id="model-active-id" class="font-mono">claude-3-5-sonnet-20241022</span>'
  )
  .replace(
    '<span>上下文 200k</span>',
    '<span id="model-active-ctx">上下文 200k</span>'
  )
  .replace(
    '<div class="provider-grid">',
    '<div id="model-provider-grid" class="provider-grid">'
  )
  .replace(
    '<p class="mt-3 text-xs text-muted-foreground">中等强度在响应速度与复杂推理之间取得平衡。</p>',
    '<p id="model-reasoning-desc" class="mt-3 text-xs text-muted-foreground">中等强度在响应速度与复杂推理之间取得平衡。</p>'
  )
  .replace(
    '<input type="text" value="http://localhost:11434" class="flex-1 min-w-0 h-9 px-3 text-xs rounded-md bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary" aria-label="Ollama 地址">',
    '<input id="model-ollama-url" type="text" value="http://localhost:11434" class="flex-1 min-w-0 h-9 px-3 text-xs rounded-md bg-input border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary" aria-label="Ollama 地址">'
  )
  .replace(
    '<button class="h-9 px-3 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors" aria-label="刷新">',
    '<button id="model-refresh-btn" class="h-9 px-3 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors" aria-label="刷新">'
  )
  .replace(
    '<button class="text-xs px-3 py-1.5 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors">添加密钥</button>',
    '<button id="model-add-key-btn" class="text-xs px-3 py-1.5 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors">添加密钥</button>'
  )
  .replace(
    '<div class="channel-row px-4 py-3 border-b border-border bg-muted text-xs text-muted-foreground">\n                  <span>模型</span>\n                  <span class="channel-provider">提供商</span>\n                  <span>能力</span>\n                </div>',
    '<div class="channel-row px-4 py-3 border-b border-border bg-muted text-xs text-muted-foreground">\n                  <span>模型</span>\n                  <span class="channel-provider">提供商</span>\n                  <span>能力</span>\n                </div>\n                <div id="model-channels-body"></div>'
  )
  .replace(
    '<div class="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-muted border border-border">\n                    <span class="font-mono text-foreground">llama3.1:latest</span>',
    '<div id="model-local-list" class="space-y-2">\n                  <div class="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-muted border border-border">\n                    <span class="font-mono text-foreground">llama3.1:latest</span>'
  )
  .replace(
    '<div class="space-y-2">\n                  <div class="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-muted border border-border">\n                    <span class="font-mono text-foreground">llama3.1:latest</span>',
    '<div id="model-local-list" class="space-y-2">\n                  <div class="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-muted border border-border">\n                    <span class="font-mono text-foreground">llama3.1:latest</span>'
  )
  // 注入 sessions 视图数据绑定 id（搜索 / 类型 / 排序 / 计数 / tbody / 新建 / 导入）
  .replace(
    '<input type="text" placeholder="搜索会话 ID 或名称" class="w-full h-9 pl-9 pr-3 rounded-md bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />',
    '<input id="sessions-search" type="text" placeholder="搜索会话 ID 或名称" class="w-full h-9 pl-9 pr-3 rounded-md bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />'
  )
  .replace(
    '<select class="h-9 px-3 rounded-md bg-card border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" aria-label="Filter by type">',
    '<select id="sessions-type" class="h-9 px-3 rounded-md bg-card border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" aria-label="Filter by type">'
  )
  .replace(
    '<select class="h-9 px-3 rounded-md bg-card border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" aria-label="Sort sessions">',
    '<select id="sessions-sort" class="h-9 px-3 rounded-md bg-card border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" aria-label="Sort sessions">'
  )
  .replace(
    '<span class="text-xs font-mono text-foreground">6</span>',
    '<span id="sessions-count" class="text-xs font-mono text-foreground">6</span>'
  )
  .replace(
    '<tbody class="divide-y divide-border">',
    '<tbody id="sessions-tbody" class="divide-y divide-border">'
  )
  .replace(
    '<button class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors" aria-label="Create session">',
    '<button id="sessions-create-btn" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors" aria-label="Create session">'
  )
  .replace(
    '<button class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-muted text-xs font-medium text-foreground hover:bg-muted-foreground/10 transition-colors" aria-label="Import sessions">',
    '<button id="sessions-import-btn" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-muted text-xs font-medium text-foreground hover:bg-muted-foreground/10 transition-colors" aria-label="Import sessions">'
  );

  // 5. theme.css：colors_and_type.css 内容
  const themeCss = fs.readFileSync(path.join(SRC, 'colors_and_type.css'), 'utf8');

  // 6. app.css：semantic fallback + critical 样式 + 额外样式 + nav-active 路由高亮
  const appCss = `/* Hyacinth WebUI — 应用样式（由 build-webui-spa 合并桌面设计稿） */
/* 语义 token fallback：Tailwind 未生成时兜底（防白屏） */
${semanticFallback}

/* critical layout + 页面额外样式 */
${uniqueStyles}

/* ── SPA 路由导航高亮（app.js 切换 .nav-active）── */
.nav-item.nav-active {
  color: var(--hyacinth-primary);
  background-color: color-mix(in srgb, var(--hyacinth-primary) 10%, transparent);
  border-right: 2px solid var(--hyacinth-primary);
}
.nav-item.nav-active i {
  color: var(--hyacinth-primary);
}
.nav-item.nav-active span {
  color: var(--hyacinth-primary);
}

/* ── 对话框（permission / ask_user）── */
.cmd-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 15vh; z-index: 300;
}
.cmd-box {
  width: 560px; max-width: 92vw;
  background: var(--hyacinth-card); color: var(--hyacinth-foreground);
  border: 1px solid var(--hyacinth-border);
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
  overflow: hidden; padding: 18px;
}
.cmd-box h4 { margin: 0 0 12px; }
.cmd-box p { font-size: 13px; margin: 0 0 14px; word-break: break-all; }
.permission-actions { display: flex; gap: 8px; justify-content: flex-end; }
.dialog-btn {
  background: var(--hyacinth-muted); color: var(--hyacinth-foreground);
  border: 1px solid var(--hyacinth-border);
  padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px;
}
.dialog-btn:hover { border-color: var(--hyacinth-primary); color: var(--hyacinth-primary); }
.ask-field { margin-bottom: 12px; }
.ask-field .ask-q { display: block; font-size: 13px; margin-bottom: 6px; }
.ask-field select, .ask-field input {
  width: 100%; background: var(--hyacinth-muted); color: var(--hyacinth-foreground);
  border: 1px solid var(--hyacinth-border);
  padding: 8px 10px; border-radius: 8px; font-size: 13px;
}
.ask-field input { box-sizing: border-box; }

/* ── thinking 指示器（事件流控制显示/隐藏）── */
#thinking-indicator { display: none; }
#thinking-indicator.active { display: flex; }

`;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), spa, 'utf8');
  fs.writeFileSync(path.join(OUT, 'theme.css'), themeCss, 'utf8');
  fs.writeFileSync(path.join(OUT, 'app.css'), appCss, 'utf8');

  console.log('=== 生成结果 ===');
  console.log('index.html:', spa.length, 'bytes');
  console.log('theme.css  :', themeCss.length, 'bytes');
  console.log('app.css    :', appCss.length, 'bytes');
  console.log('--- 视图大小 ---');
  console.log('chat     :', chatView.length);
  console.log('model    :', modelView.length);
  console.log('sessions :', sessionsView.length);
  console.log('settings :', settingsView.length);
  console.log('companion:', companionView.length);
  console.log('--- shell 是否含导航链接 ---');
  console.log('hash 链接数:', (shell.match(/href="#\//g) || []).length);
}

try {
  main();
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
