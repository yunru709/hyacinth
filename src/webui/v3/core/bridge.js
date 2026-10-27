import { attachDomains } from './domains.js';
/* ============================================================================
   Hyacinth v3 — 共用核心（不含任何 UI）

   设计语言（langs/*）只管怎么画、怎么交互；
   这一层只管：连后端、发请求、收事件、管会话。

   ⚠️ 为什么必须共用而不是每套语言各写一份：
     协议一改，五套语言就得改五遍 ⇒ 迟早漂移。
     共用层是「契约」，设计语言是「表现」，两者不能混。
   ========================================================================== */

/* ═══ 协议客户端 ═════════════════════════════════════════════════════════ */
export class Client {
  constructor() {
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
    this.connected = false;
    this.closedByUser = false;
    this.delay = 800;
    this.handlers = {};
    /**
     * 后端是否已完成 attach。
     * ⚠️ 只有 ws.onopen 是不够的 —— 实测：在 onopen 里发 session.list /
     * config.getAll / model.listProviders / skill.list，**四个全部无响应**，
     * 而且连 error 都不回（后端还没挂处理器，消息直接丢掉）。
     * 真正的"可以发请求"信号是 ui.connected 事件。
     */
    this.ready = false;
  }

  connect() {
    if (this.closedByUser) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = new URLSearchParams(location.search).get('token');
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ui${qs}`);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.ready = false;   // 重连后必须重新等 ui.connected
      this.delay = 800;
      this.handlers.onOpen?.();
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.kind === 'response') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(m.error || { message: 'error' });
      } else if (m.kind === 'event') {
        // ui.connected = 后端 attach 完成 ⇒ 此刻起请求才有响应
        if (m.type === 'ui.connected' && !this.ready) {
          this.ready = true;
          this.handlers.onReady?.(m.payload);
        }
        this.handlers.onEvent?.(m.type, m.payload);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.handlers.onClose?.();
      if (this.closedByUser) return;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 10000);
    };
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
        reject({ message: '未连接' });
        return;
      }
      const id = 'r' + (++this.seq);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  /** 主动断开并停止自动重连（SPA 卸载语言 / 离开 v3 时调用）。 */
  dispose() {
    this.closedByUser = true;
    try { this.ws?.close(); } catch { /* 可能已关 */ }
    for (const p of this.pending.values()) { try { p.reject({ message: 'disposed' }); } catch { /* 忽略 */ } }
    this.pending.clear();
    this.connected = false;
  }
}

/* ═══ 会话数据（与 UI 无关）══════════════════════════════════════════════
   只负责取数、格式化，不碰 DOM。两套设计语言各自决定怎么渲染。 */
export class Sessions {
  constructor(client) {
    this.client = client;
    this.cache = [];
  }

  async list() {
    try {
      const res = await this.client.request('session.list', {});
      this.cache = res?.sessions || res || [];
    } catch (err) {
      // ⚠️ 不要吞掉：静默失败会表现成"会话列表为空"，看起来像没数据而非出错
      console.warn('[Sessions.list] 失败:', err?.message ?? err);
      this.cache = this.cache || [];
    }
    return this.cache;
  }

  /** 标题兜底：没有 title 就用 id 尾部，再没有就给「未命名」。
   *  ⚠️ 必须是实例方法：两套语言的调用点都是 `sessions.titleOf(s)`。
   *  写成 static 会抛 TypeError，且 try/catch 会把它吞成"看起来正常"的空白页。 */
  titleOf(s) {
    if (!s) return '未命名';
    if (s.title) return s.title;
    if (s.id) return '…' + String(s.id).slice(-8);
    return '未命名';
  }
}

/* ═══ 主题 × 配色（两套语言共用同一份清单，但各自决定怎么呈现）═══════
   注意：这里只提供**数据**，不提供 DOM。TUI 用键盘列表呈现，
   Editorial 用文字段落呈现 —— 呈现方式属于设计语言。 */
export const THEMES = ['void', 'flow', 'focus', 'console', 'reading'];
export const PALETTES = ['night', 'day', 'sepia', 'mono', 'forest'];

export const THEME_LABELS = {
  void: '极简', flow: '流体', focus: '专注', console: '终端', reading: '阅读',
};
export const PALETTE_LABELS = {
  night: '夜', day: '日', sepia: '褐', mono: '单色', forest: '林',
};

/* ═══ 消息流：把后端事件翻译成「一段文本属于谁」══════════════════════════
   两套语言的渲染方式完全不同（TUI 追加到日志区，Editorial 追加到正文），
   但「怎么判断是增量还是完成」必须一致，所以放这里。 */
export class MessageStream {
  constructor(client) {
    this.client = client;
    this.buffer = "";     // message.text 累积（流式增量）
    this.inTurn = false;
    this.handlers = {};
    this.bind();
  }

  /**
   * ⚠️ 事件名与 payload 以 v1 `app.js` L902-1012 为准 —— 这里曾经全是猜的
   *    （message.delta / message.done / turn.start / turn.end），一个都不存在。
   *
   *   真实事件：
   *     message.turn_start   {}                          回合开始
   *     message.text         {content}                   流式增量（不是完整文本）
   *     message.say          {content}                   交付结论（模型的"嘴"）
   *     message.thinking     {content}
   *     message.tool_use     {name, inputSummary}
   *     message.tool_result  {content, isError}
   *     message.turn_info    {}                          回合真正结束
   *     message.error        {message}
   *     message.interrupt    {}
   */
  bind() {
    this.client.handlers.onEvent = (type, payload) => {
      const p = payload || {};
      switch (type) {
        case "message.turn_start":
          this.inTurn = true;
          this.buffer = "";
          this.handlers.onTurnStart?.();
          break;

        case "message.text":
          // 流式增量：把本块追加进缓冲，并把"到目前为止的全文"给上层
          if (p.content) {
            this.buffer += p.content;
            this.handlers.onAssistantDelta?.(p.content, this.buffer);
          }
          break;

        case "message.say":
          // 「交付结论」优先于流式文本：有它就用它收尾
          if (p.content) {
            this.handlers.onAssistantDone?.(p.content);
            this.buffer = "";
          }
          break;

        case "message.thinking":
          this.handlers.onThinking?.(p.content || "");
          break;

        case "message.tool_use":
          this.handlers.onToolUse?.(p.name || "tool", p.inputSummary || "");
          break;

        case "message.tool_result":
          this.handlers.onToolResult?.(p.content || "", p.isError === true);
          break;

        case "message.turn_info":
          // 回合真正结束（v1 在这里 setBusy(false)）。缓冲还有东西就顺手收尾。
          if (this.buffer) {
            this.handlers.onAssistantDone?.(this.buffer);
            this.buffer = "";
          }
          this.inTurn = false;
          this.handlers.onTurnEnd?.();
          break;

        case "message.error":
          this.inTurn = false;
          this.handlers.onError?.(p.message || "未知错误");
          break;

        case "message.interrupt":
          this.inTurn = false;
          this.handlers.onInterrupt?.();
          break;

        default:
          break;
      }
    };
  }

  async send(text) {
    this.handlers.onUserSend?.(text);
    this.buffer = "";
    // ⚠️ 参数名是 content，不是 text（v1 app.js:5210 实证）
    await this.client.request("message.chat", { content: text });
  }

  async stop() {
    try { await this.client.request("message.stop", {}); } catch { /* 可能已 idle */ }
  }
}

/* ═══ 历史消息 ═══════════════════════════════════════════════════════════
   后端 message.history({ sessionId }) 返回的是**事件流**，不是对话消息：
     session_start / user_input / text / thinking / tool_call / tool_result
     / usage / stop
   所以这里只做两件事：取原始事件 + 提供一个"归一化"视图。
   **怎么渲染是各设计语言自己的事** —— TUI 要工具调用，Editorial 不要。
   ══════════════════════════════════════════════════════════════════════ */
export class History {
  constructor(client) { this.client = client; }

  async load(sessionId) {
    if (!sessionId) return [];
    try {
      const res = await this.client.request("message.history", { sessionId });
      const msgs = res?.messages;
      if (!Array.isArray(msgs)) {
        console.warn("[History.load] 返回不是数组:", res);
        return [];
      }
      return msgs;
    } catch (err) {
      console.warn("[History.load] 失败:", err?.message ?? err);
      return [];
    }
  }
}

/** 把事件流压成可读条目。
 *  opts.tools 为 true 时保留工具调用/结果（TUI 用），否则只留对话正文（Editorial 用）。
 *  工具结果一律截断 —— 它可能是几十 KB 的日志，撑爆界面。 */
export function toEntries(messages, opts = {}) {
  const withTools = opts.tools === true;
  const out = [];

  /**
   * ⚠️ 必须是**两个独立缓冲**。
   *   实测真实流是 `thinking → text → thinking → text → …` **交替**的
   *   （21 条 text 被 20 个 thinking 隔开）。
   *   若让 thinking 去 flush assistant 缓冲，每个 chunk 都会变成独立段落
   *   —— 实测把一段话渲染成 19 个碎片。
   */
  let aBuf = null;   // assistant 正文
  let tBuf = null;   // thinking（是否输出由 withTools 决定）

  const flushA = () => { if (aBuf && aBuf.text) out.push(aBuf); aBuf = null; };
  const flushT = () => { if (tBuf && tBuf.text && withTools) out.push(tBuf); tBuf = null; };
  /** 顺序：thinking 先于正文（它发生在说话之前） */
  const flushAll = () => { flushT(); flushA(); };

  for (const m of messages || []) {
    switch (m.type) {
      case "user_input":
        flushAll();
        out.push({ kind: "user", text: m.content || "" });
        break;

      case "text":
        if (aBuf) aBuf.text += m.content || "";
        else aBuf = { kind: "assistant", text: m.content || "" };
        break;

      case "thinking":
        if (!withTools) break;          // 关键：这里**不 flush**
        if (tBuf) tBuf.text += m.content || "";
        else tBuf = { kind: "thinking", text: m.content || "" };
        break;

      case "tool_call": {
        flushAll();
        if (withTools) {
          const arg = JSON.stringify(m.input ?? {});
          out.push({ kind: "tool", text: (m.name || "tool") + " " + (arg.length > 90 ? arg.slice(0, 90) + "…" : arg) });
        }
        break;
      }

      case "tool_result": {
        flushAll();
        if (withTools) {
          const t = String(m.content ?? "");
          out.push({ kind: "result", text: t.length > 200 ? t.slice(0, 200) + "…" : t });
        }
        break;
      }

      default:
        flushAll();     // usage / stop / session_start = 轮边界
        break;
    }
  }
  flushAll();
  return out;
}
/* ═══ 启动助手：所有语言都走这一条路 ═══════════════════════════════════════ */
export function boot() {
  const client = new Client();
  const sessions = new Sessions(client);
  const stream = new MessageStream(client);
  const history = new History(client);

  const q = new URLSearchParams(location.search);

  const app = {
    client,
    sessions,
    stream,
    history,
    /** 当前语言名（来自 ?lang=terminal） */
    lang: q.get('lang') || 'terminal',
    /** 初始主题 / 配色（URL 优先，其次 localStorage） */
    theme: q.get('theme') || localStorage.getItem('h3.theme') || 'void',
    palette: q.get('palette') || localStorage.getItem('h3.palette') || 'night',
    setTheme(name) {
      localStorage.setItem('h3.theme', name);
      document.documentElement.setAttribute('data-theme', name);
    },
    setPalette(name) {
      localStorage.setItem('h3.palette', name);
      document.documentElement.setAttribute('data-palette', name);
    },
  };

  /* 挂上全部功能域（config / model / voice / caps / runtime / sessionAdmin）。
     ⚠️ 语言层因此不必直接拼 RPC —— 契约坑（config 用 path、history 用 sessionId…）
        都收在 core/domains.js 里，三套语言共享一份正确。 */
  return attachDomains(app);
}

/* ═══ 演示数据（?demo=1）═══════════════════════════════════════════════════
   为什么要它：空界面无法公平评判设计语言 —— 「什么都没画」和「画得不好」
   在截图里长得一样。灌同一份内容进两套语言，才看得出骨架差异。

   为什么放 core 而不是各语言自己写：内容必须完全相同，否则对比失真。 */
export const DEMO = {
  sessions: [
    { id: 's1', title: '重构 v3 主题层' },
    { id: 's2', title: 'TTS 引擎顺序加载' },
    { id: 's3', title: '缓存命中率诊断' },
  ],
  messages: [
    { role: 'user', text: '把 v3 的主题层重构成设计语言。' },
    {
      role: 'assistant',
      text: '理解了。设计语言不等于主题：主题只换皮肤，设计语言换的是布局范式、交互规范和控件体系。\n\n按这个思路，我把一套「HTML + 变量」拆成了：core 管协议，langs/* 各自建骨架。',
    },
    { role: 'user', text: '先做两套看看效果。' },
    {
      role: 'assistant',
      text: 'TUI 走键盘优先的分面板，Editorial 走单栏无界面的正文流。\n\n同一份 core，两套完全不同的骨架 —— 这才叫换设计语言。',
    },
  ],
  isDemo: () => new URLSearchParams(location.search).get('demo') === '1',
};
