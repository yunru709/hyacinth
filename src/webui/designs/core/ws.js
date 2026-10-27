/* ============================================================================
   协议客户端 — 所有设计语言共用
   
   这是唯一的共用层。再往上（布局、控件、交互）各语言自己实现。
   
   线协议与 v1 完全一致（后端无需改动）：
     发  { kind:'request', id, method, params }
     收  { kind:'response', id, ok, result|error }
     收  { kind:'event', type, payload }
   ========================================================================== */

export class Client {
  constructor() {
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
    this.connected = false;
    this.closedByUser = false;
    this.delay = 800;
    this.handlers = {};
  }

  on(handlers) {
    Object.assign(this.handlers, handlers);
    return this;
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
        this.handlers.onEvent?.(m.type, m.payload);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.handlers.onClose?.();
      if (this.closedByUser) return;
      // 退避重连：0.8s → 1.6s → 3.2s …，上限 10s
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 10000);
    };

    ws.onerror = () => { /* onclose 会紧随其后，重连逻辑统一放那里 */ };
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

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

/** 全局单例：切换设计语言时不重建连接，会话状态不丢。 */
export const client = new Client();
