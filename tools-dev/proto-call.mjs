// tools-dev/proto-call.mjs —— 通用协议调用器（诊断/验证用 ✓）
//
// 用法：node tools-dev/proto-call.mjs <method> ['{"k":v}']
// 例：  node tools-dev/proto-call.mjs orchestrator.get
//       node tools-dev/proto-call.mjs state.stats '{"sessionId":"..."}'
//
// 为什么需要它：**接 UI 之前先确认后端真的能答** ✗ ——
// 否则会给一个报错的接口做按钮（用户点下去就红 ✗）。
// 零依赖（Node 自带 WebSocket ✓）。
const URL_ = process.env.WS_URL || 'ws://127.0.0.1:3100/ui';
const method = process.argv[2];
// ⚠️ PowerShell 会把参数里的双引号吃掉 ✗（实测 `{"sessionId":"x"}` 到 node 时引号已丢 ✓）
// ⇒ 同时支持从环境变量传参：`$env:PROTO_PARAMS='{"k":"v"}'` ⇒ 绕开 shell 引号 ✓
const params = process.env.PROTO_PARAMS
  ? JSON.parse(process.env.PROTO_PARAMS)
  : (process.argv[3] ? JSON.parse(process.argv[3]) : {});
if (!method) { console.log('用法: node tools-dev/proto-call.mjs <method> [jsonParams]'); process.exit(2); }

const ws = new WebSocket(URL_);
const to = setTimeout(() => { console.log('✗ 10s 无应答'); process.exit(1); }, 10000);
ws.addEventListener('message', (e) => {
  let m;
  try { m = JSON.parse(String(e.data)); } catch { return; }
  const kind = m.kind || m.type;
  if (kind === 'event' && String(m.type || '').includes('connected')) {
    ws.send(JSON.stringify({ kind: 'request', id: 1, method, params }));
    return;
  }
  if (m.id === 1) {
    clearTimeout(to);
    const ok = !m.error;
    console.log((ok ? '✓ ' : '✗ ') + method + (ok ? ' 返回：' : ' 报错：'));
    console.log(JSON.stringify(m.error || m.result || m.data || m, null, 2).slice(0, 2500));
    ws.close();
    process.exit(ok ? 0 : 1);
  }
});
ws.addEventListener('error', () => { console.log('✗ WS 连接错误'); process.exit(1); });
