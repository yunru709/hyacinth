// tools-dev/protocol-audit.mjs —— 协议层 vs WebUI 前端 的接口对账
//
// 为什么要它：`message.say` 那次事故（后端一路在发、前端没有分支 ⇒ 用户看不到最终输出 ✗）
// 属于同一族：**两侧清单不同步**。这里把两侧都拉出来逐条对 ✓，且**双向**对：
//   ① 协议有、前端没用 ⇒ 功能缺口（可能是缺 UI，也可能是没做）
//   ② 前端在调、协议没有 ⇒ **必炸**（调用即 UNKNOWN_METHOD ✗）
//   ③ 事件声明了、前端没分支 ⇒ **收不到**（say 那一类 ✗）
//
// 权威来源：协议自带 `meta.get`（运行时能力清单：每域有哪些方法 ✓）
// 零依赖：Node 自带 WebSocket ✓
const URL_ = process.env.WS_URL || 'ws://127.0.0.1:3100/ui';
const ROOT = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth';
import fs from 'node:fs';

const appJs = fs.readFileSync(ROOT + '\\src\\webui\\app.js', 'utf8');
const eventsTs = fs.readFileSync(ROOT + '\\src\\events.ts', 'utf8');

// ── 前端侧：调了哪些方法 ──────────────────────────────────────
const usedMethods = new Set();
for (const m of appJs.matchAll(/client\.request\(\s*'([^']+)'/g)) usedMethods.add(m[1]);
// 动态拼接的调用（'companion.' + x 之类）单独提示，避免漏计 ✗
const dynamicCalls = [...appJs.matchAll(/client\.request\(\s*([^'")][^,)]*)/g)]
  .map((m) => m[1].trim())
  .filter((s) => s && !s.startsWith("'"));
// 前端侧：认了哪些事件（handleEvent 的 case ✓）
const handledEvents = new Set();
for (const m of appJs.matchAll(/^\s+case\s+'([^']+)'/gm)) handledEvents.add(m[1]);
// 协议侧：events.ts 声明的事件常量
const declaredEvents = new Set();
for (const m of eventsTs.matchAll(/^\s+[A-Z][A-Z_]*:\s*'([^']+)',/gm)) declaredEvents.add(m[1]);

// ── 连一次 WS，问 meta.get ────────────────────────────────────
const t0 = Date.now();
const ws = new WebSocket(URL_);
let meta = null;
let rawSample = null;
const to = setTimeout(() => { console.log('✗ 10s 未拿到 meta.get 结果'); process.exit(1); }, 10000);

ws.addEventListener('message', (e) => {
  let msg;
  try { msg = JSON.parse(String(e.data)); } catch { return; }
  const kind = msg.kind || msg.type;
  if (kind === 'event' && String(msg.type || '').includes('connected')) {
    ws.send(JSON.stringify({ kind: 'request', id: 1, method: 'meta.get', params: {} }));
    return;
  }
  // 应答：信封可能是 response/result，也可能只靠 id 配对 ⇒ 两种都收 ✓
  if (msg.id === 1 || kind === 'response' || kind === 'result') {
    rawSample = JSON.stringify(msg).slice(0, 200);
    meta = msg.result || msg.data || msg.payload || null;
    clearTimeout(to);
    ws.close();
  }
});
ws.addEventListener('error', () => { console.log('✗ WS 连接错误'); process.exit(1); });

setTimeout(() => {
  if (!meta) {
    console.log('✗ 未取到 meta（信封没对上）⇒ 原始应答样本：' + rawSample);
    console.log('  （说明我要先修正信封解析 ✗，而不是下结论）');
    process.exit(1);
  }

  const provided = new Set();
  const byDomain = {};
  for (const d of Object.keys(meta.methods || {})) {
    byDomain[d] = meta.methods[d];
    for (const a of meta.methods[d]) provided.add(d + '.' + a);
  }

  console.log('════ 协议层能力（meta.get 实时清单，' + (Date.now() - t0) + 'ms）════');
  console.log('  协议版本 = ' + (meta.version || '?') + '；域数 = ' + Object.keys(byDomain).length + '；方法数 = ' + provided.size);
  for (const d of Object.keys(byDomain).sort()) {
    console.log('   · ' + d.padEnd(14) + byDomain[d].length + ' 个 → ' + byDomain[d].join(', '));
  }

  console.log('');
  console.log('════ ① 协议有、前端**没用**（功能缺口）════');
  const unused = [...provided].filter((m) => !usedMethods.has(m)).sort();
  const unusedByDomain = {};
  for (const m of unused) {
    const d = m.split('.')[0];
    (unusedByDomain[d] = unusedByDomain[d] || []).push(m.slice(d.length + 1));
  }
  for (const d of Object.keys(unusedByDomain).sort()) {
    const all = byDomain[d] || [];
    const used = all.filter((a) => usedMethods.has(d + '.' + a));
    const flag = used.length === 0 ? '【整域未用】' : '';
    console.log('   ' + d.padEnd(14) + flag + ' 未用 ' + unusedByDomain[d].length + '/' + all.length + ' → ' + unusedByDomain[d].join(', '));
  }
  console.log('   小计：未用 ' + unused.length + ' / 共 ' + provided.size);

  console.log('');
  console.log('════ ② 前端在调、协议**没有**（必炸 ✗）════');
  const broken = [...usedMethods].filter((m) => !provided.has(m)).sort();
  if (broken.length === 0) console.log('   ✓ 无（前端没调用不存在的方法）');
  else for (const m of broken) console.log('   ✗ ' + m);

  console.log('');
  console.log('════ ③ 事件：声明了、前端没有分支（收不到 ✗）════');
  const unhandled = [...declaredEvents].filter((ev) => !handledEvents.has(ev)).sort();
  if (unhandled.length === 0) console.log('   ✓ 无');
  else for (const ev of unhandled) console.log('   ✗ ' + ev);

  console.log('');
  console.log('════ ④ 前端在认、但协议未声明（幽灵分支，无害但可疑）════');
  const ghosts = [...handledEvents].filter((ev) => ev.includes('.') && !declaredEvents.has(ev)).sort();
  if (ghosts.length === 0) console.log('   ✓ 无');
  else for (const ev of ghosts) console.log('   · ' + ev);

  console.log('');
  console.log('   前端调用方法数 = ' + usedMethods.size + '；handleEvent 分支数 = ' + handledEvents.size);
  if (dynamicCalls.length) console.log('   ⚠ 动态拼接的调用（本脚本数不到，需人工看）：' + dynamicCalls.join(' | '));
  process.exit(0);
}, 1500);
