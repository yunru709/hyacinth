/* ============================================================================
   Hyacinth WebUI v2 — 状态与路由

   设计取舍（2026-10-27 全量重做）：

   1. **没有全局 store**。
      v1 把所有状态塞进一个闭包，靠几十个 render 函数手工同步，最终没人说得清
      某个变量在什么时候被谁改过。v2 的约定是：状态跟着**拥有它的视图**走，
      视图只暴露 refresh() 供外部触发。跨视图共享的只有两样：WS 客户端、当前会话 id。

   2. **路由只切 hidden，不重建 DOM**。
      视图首次进入时构建，之后只更新数据。这样切换视图不丢输入框内容、
      不重放滚动位置，也不需要"恢复状态"的补偿逻辑。

   3. **hash 是唯一真源**。
      不额外维护 currentView 变量；任何地方要知道当前视图就读 location.hash。
      多一份状态就多一处可能不同步。
   ========================================================================== */

/** 视图元数据：id → 面包屑文案。顺序也决定导航顺序。 */
export const VIEWS = {
  chat:     { label: '对话' },
  model:    { label: '模型' },
  sessions: { label: '会话' },
  skills:   { label: '技能' },
  plugins:  { label: '插件' },
  schedule: { label: '定时任务' },
  settings: { label: '设置' },
};

/** 从 hash 解析当前视图，容忍非法值（一律回落到 chat）。 */
export function currentView() {
  const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return Object.hasOwn(VIEWS, raw) ? raw : 'chat';
}

/** 跳到某个视图。用 hash 而不是 pushState：刷新/前进后退天然可用。 */
export function go(view) {
  if (!Object.hasOwn(VIEWS, view)) return;
  const target = `#/${view}`;
  if (location.hash === target) return;
  location.hash = target;
}

/**
 * 视图控制器。
 *
 * 每个视图模块导出 { mount(el), unmount?(), refresh?() }：
 *   mount    首次进入时调用一次，负责构建 DOM 骨架并绑定事件
 *   refresh  每次进入时调用（含从别的视图切回来），用于拉最新数据
 *   unmount  可选，仅用于需要主动释放资源（定时器、订阅）的视图
 *
 * 为什么 mount 与 refresh 分开：重新进入视图时重建 DOM 会丢滚动位置和输入内容；
 * 但完全不刷新又会显示陈旧数据。分开就能"骨架只建一次，数据每次都新"。
 */
export class ViewRouter {
  #controllers = new Map();   // view → { instance, host }
  #active = null;

  constructor({ onBeforeSwitch } = {}) {
    this.onBeforeSwitch = onBeforeSwitch;
  }

  register(view, controller) {
    this.#controllers.set(view, { controller, instance: null, host: null });
  }

  /** 应用当前 hash：切显示、更新导航高亮、触发 mount/refresh。 */
  apply() {
    const view = currentView();

    // 顶部面包屑
    const crumb = document.querySelector('.tb-crumb');
    if (crumb) crumb.textContent = VIEWS[view].label;

    // 侧栏导航高亮：只高亮主视图，settings 不占导航位（它由顶栏齿轮进入）
    for (const item of document.querySelectorAll('.sb-nav-item')) {
      item.classList.toggle('is-active', item.dataset.view === view);
    }

    // 切换 section 可见性
    for (const section of document.querySelectorAll('section.view')) {
      section.hidden = section.dataset.view !== view;
    }

    // 视图生命周期
    if (this.#active && this.#active !== view) {
      const prev = this.#controllers.get(this.#active);
      prev?.instance?.unmount?.();
    }

    const entry = this.#controllers.get(view);
    if (entry) {
      if (!entry.instance) {
        entry.host = document.querySelector(`section.view[data-view="${view}"]`);
        entry.instance = entry.controller;
        entry.instance.mount?.(entry.host);
      }
      entry.instance.refresh?.();
    }

    this.#active = view;
    this.onBeforeSwitch?.(view);
  }

  start() {
    window.addEventListener('hashchange', () => this.apply());
    this.apply();
  }
}
