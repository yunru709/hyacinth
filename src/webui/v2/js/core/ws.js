/* ============================================================================
   Hyacinth WebUI v2 — 协议客户端

   与后端的唯一通道：一条 WebSocket，JSON 帧。
   这是**与 v1 完全一致的线协议**（kind: request/response/event），
   所以后端一行不用改。v2 只换表现层。

   帧格式（读 v1 app.js 与后端契约确认）：
     发  { kind:'request', id, method, params }
     收  { kind:'response', id, ok, result|error }
     收  { kind:'event', type, payload }
   ========================================================================== */

export class ProtocolClient {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
    this.connected = false;
    this.closedByUser = false;
    this.reconnectDelay = 800;
    this.reconnectTimer = null;
    /** @type {{onOpen?:Function,onClose?:Function,onEvent?:Function,onState?:Function}} */
    this.handlers = {};
  }

  on(handlers) {
    Object.assign(this.handlers, handlers);
    return this;
  }

  connect() {
    if (this.closedByUser) return;

    // WS 地址：当前页同源，协议换成 ws。
    // token 从 URL 查询参数带过来（后端支持 ?token=，浏览器加载 WS 无法设自定义头）。
    const base = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = new URLSearchParams(location.search).get('token');
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const url = `${base}//${location.host}/ui${qs}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 800;
      this.handlers.onOpen?.();
      this.handlers.onState?.('online');
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.#dispatch(msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.handlers.onClose?.();
      this.handlers.onState?.('offline');
      if (this.closedByUser) return;
      // 退避重连：0.8s → 1.6s → 3.2s → 6.4s，上限 10s。
      // 不无限快重试：后端重启通常几秒，快速重试只会刷日志。
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    };

    ws.onerror = () => {
      // onerror 之后必有 onclose，重连逻辑统一放那里，这里不重复处理。
    };
  }

  #dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'response') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(msg.error || { code: 'ERROR', message: 'unknown error' });
      return;
    }

    if (msg.kind === 'event') {
      this.handlers.onEvent?.(msg.type, msg.payload);
    }
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject({ code: 'NOT_CONNECTED', message: '连接未建立' });
        return;
      }
      const id = 'r' + (++this.seq);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}

/* ── 便捷封装 ────────────────────────────────────────────────────────────
   视图里大量重复 "await client.request(...)"，包一层让调用点更短，
   同时把错误统一成可读字符串（视图不需要理解 {code,message} 结构）。 */
export function call(client, method, params) {
  return client.request(method, params).catch((err) => {
    const message = typeof err === 'string' ? err : (err?.message || '请求失败');
    const code = err?.code || 'ERROR';
    throw new Error(`${code}: ${message}`);
  });
}
