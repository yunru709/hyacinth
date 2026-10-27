/* ============================================================================
   Hyacinth WebUI v2 — 应用装配

   职责边界（唯一）：
     建客户端 → 连 WS → 注册视图 → 启路由 → 分发事件到当前视图

   它不做业务：不渲染消息、不读配置、不管标签。那些都在各自视图里。
   v1 的 app.js 把这些全塞在一起（8352 行），是"改一处崩三处"的根源。
   ========================================================================== */

import { ProtocolClient } from './core/ws.js';
import { ViewRouter, currentView, go, VIEWS } from './core/router.js';

import { chatView } from './views/chat.js';
import { modelView } from './views/model.js';
import { sessionsView, skillsView, pluginsView, scheduleView, settingsView } from './views/all.js';

/* ── 全局连接（跨视图唯一共享的东西）─────────────────────────────────── */
export const client = new ProtocolClient();

/** 当前活跃的会话 id。由 chat 视图维护，其他视图只读。 */
export const appState = {
  sessionId: null,
  connected: false,
  running: false,
};

const views = {
  chat: chatView,
  model: modelView,
  sessions: sessionsView,
  skills: skillsView,
  plugins: pluginsView,
  schedule: scheduleView,
  settings: settingsView,
};

const router = new ViewRouter({
  onBeforeSwitch(view) {
    // 切走时收起窄屏抽屉，避免遮住新视图
    document.getElementById('app')?.setAttribute('data-sidebar', 'collapsed');
    document.title = `Hyacinth — ${VIEWS[view].label}`;
  },
});

/* ── 顶栏与侧栏的通用交互 ─────────────────────────────────────────────── */
function bindShell() {
  const app = document.getElementById('app');

  // 侧栏折叠：宽屏用 margin 动画，窄屏用 transform（样式在 shell.css）
  document.getElementById('scope-toggle')?.addEventListener('click', () => {
    const cur = app.getAttribute('data-sidebar');
    app.setAttribute('data-sidebar', cur === 'collapsed' ? 'expanded' : 'collapsed');
    localStorage.setItem('h2.sidebar', cur === 'collapsed' ? 'expanded' : 'collapsed');
  });
  const saved = localStorage.getItem('h2.sidebar');
  if (saved) app.setAttribute('data-sidebar', saved);
  else if (window.innerWidth <= 860) app.setAttribute('data-sidebar', 'collapsed');
  else app.setAttribute('data-sidebar', 'expanded');

  // 顶栏设置按钮 → 设置页
  document.getElementById('settings-btn')?.addEventListener('click', () => go('settings'));
  document.getElementById('model-chip')?.addEventListener('click', () => go('model'));

  // 连接状态灯
  const conn = document.getElementById('conn-state');
  const dot = document.getElementById('model-dot');
  client.on({
    onState(state) {
      appState.connected = state === 'online';
      if (conn) {
        conn.dataset.state = state;
        conn.textContent = state === 'online' ? '已连接' : '离线';
      }
      if (dot && state === 'offline') dot.dataset.state = 'offline';
    },
  });
}

/** 更新顶栏模型名。任何视图改了模型都调这里，保证全局一致。 */
export function setModelLabel(text, state) {
  const el = document.getElementById('model-name');
  if (el) el.textContent = text;
  const dot = document.getElementById('model-dot');
  if (dot && state) dot.dataset.state = state;
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */
async function boot() {
  bindShell();

  for (const [view, controller] of Object.entries(views)) {
    router.register(view, controller);
  }

  client.on({
    onOpen() {
      // 连接建立后才启路由：视图的 refresh() 会立刻发请求，
      // 早于此启动会收到一批 NOT_CONNECTED 噪音。
      router.start();
      chatView.attach?.(client);
    },
    onEvent(type, payload) {
      // 事件分发给所有已挂载视图：各自判断是否与自己相关。
      // 不做中心化分派表 —— 那会让"谁能收到什么"变成隐式契约。
      for (const controller of Object.values(views)) {
        controller.onEvent?.(type, payload, appState);
      }
    },
  });

  client.connect();
}

// 视图需要导航能力，统一从 router 模块拿（避免每个视图各写一份 hash 逻辑）
export { go, currentView };

boot().catch((err) => {
  console.error('[v2] boot failed', err);
  const crumb = document.querySelector('.tb-crumb');
  if (crumb) crumb.textContent = '初始化失败';
});
