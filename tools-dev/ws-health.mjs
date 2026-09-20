// tools-dev/ws-health.mjs —— 网页后端健康探针：**握手后多久收到第一条消息**
//
// 为什么需要它（2026-09-20 实证 ✗）：MCP 进程风暴时，WS **能握手**（77ms）
// 但后端**迟迟不发首条消息** ⇒ 页面永远卡在「连接中…」✗ ——
// 也就是说「握手成功」**不等于**「页面可用」✗ ⇒ 判据必须落在**首条消息**上 ✓
//
// 用法：node tools-dev/ws-health.mjs
// 环境变量：WS_URL（默认 ws://127.0.0.1:3100/ui）、WS_LIMIT_MS（默认 8000）
const URL_ = process.env.WS_URL || 'ws://127.0.0.1:3100/ui';
const LIMIT_MS = Number(process.env.WS_LIMIT_MS || 8000);
const t0 = Date.now();
let handshake = null;
let ws;
const done = (code) => { try { ws.close(); } catch { /* ignore */ } process.exit(code); };
const timer = setTimeout(() => {
  console.log(`✗ ${LIMIT_MS}ms 内未收到首条消息 ⇒ 后端会话初始化卡住（页面会一直显示"连接中…"）`);
  console.log(`  握手耗时 = ${handshake === null ? '未握手成功' : handshake + 'ms'}`);
  done(1);
}, LIMIT_MS);

try {
  ws = new WebSocket(URL_);
} catch (e) {
  console.log('✗ 无法创建连接：' + e.message);
  process.exit(1);
}
ws.addEventListener('open', () => { handshake = Date.now() - t0; });
ws.addEventListener('message', (e) => {
  const first = Date.now() - t0;
  console.log(`✓ 首条消息 ${first}ms（握手 ${handshake}ms）`);
  console.log('  内容 = ' + String(e.data || '').slice(0, 200));
  clearTimeout(timer);
  done(first <= 5000 ? 0 : 2);   // 健康判据：≤5s ✓
});
ws.addEventListener('error', () => {
  console.log('✗ 连接错误（后端没起？端口不通？）');
  clearTimeout(timer);
  done(1);
});
