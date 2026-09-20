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
//
// ⚠️ 首版教训（2026-09-20，**当天就踩到** ✗）：
//   只认 `client.request('字面量')` 会让**动态分派**的调用隐形 ——
//   例：MCP 启停写成 `c ? 'mcp.enable' : 'mcp.disable'` ⇒ 首版把**已经接好的**功能
//   误报成"未用" ✗（差点据此去重复实现 ✗）。
//   ⇒ 现在**双通道**识别：① 直调  ② 方法名以**任意字面串**出现在文件里（动态分派 ✓）
//   ⇒ 两者分开汇报，不混为一谈 ✓
const URL_ = process.env.WS_URL || 'ws://127.0.0.1:3100/ui';
const ROOT = 'C:\\Users\\74689\\Desktop\\Agent\\hyacinth';
import fs from 'node:fs';

const appJs = fs.readFileSync(ROOT + '\\src\\webui\\app.js', 'utf8');
const eventsTs = fs.readFileSync(ROOT + '\\src\\events.ts', 'utf8');

// ── 前端侧：① 直调 ────────────────────────────────────────────
const directMethods = new Set();
for (const m of appJs.matchAll(/client\.request\(\s*'([^']+)'/g)) directMethods.add(m[1]);
// ── 前端侧：② 字面串（含动态分派；比直调宽，误收的只会让"未用"变少 ⇒ 宁可保守 ✓）──
const literalMethods = new Set(
  [...appJs.matchAll(/'([a-z][a-zA-Z]*\.[a-zA-Z_.]+)'/g)].map((m) => m[1]),
);
// ── 前端侧：认了哪些事件（handleEvent 的 case ✓）──
const handledEvents = new Set();
for (const m of appJs.matchAll(/^\s+case\s+'([^']+)'/gm)) handledEvents.add(m[1]);
// ── 协议侧：events.ts 声明的事件常量 ──
const declaredEvents = new Set();
for (const m of eventsTs.matchAll(/^\s+[A-Z][A-Z_]*:\s*'([^']+)',/gm)) declaredEvents.add(m[1]);

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
    process.exit(1);
  }

  const provided = new Set();
  const byDomain = {};
  for (const d of Object.keys(meta.methods || {})) {
    byDomain[d] = meta.methods[d];
    for (const a of meta.methods[d]) provided.add(d + '.' + a);
  }

  // 动态分派：字面串命中「协议确实提供的方法」且不是直调 ⇒ 记为"疑似动态已接" ✓
  const dynUsed = [...literalMethods].filter((m) => provided.has(m) && !directMethods.has(m)).sort();
  const usedAll = new Set([...directMethods, ...dynUsed]);

  console.log('════ 协议层能力（meta.get 实时清单，' + (Date.now() - t0) + 'ms）════');
  console.log('  协议版本 = ' + (meta.version || '?') + '；域数 = ' + Object.keys(byDomain).length + '；方法数 = ' + provided.size);
  for (const d of Object.keys(byDomain).sort()) {
    console.log('   · ' + d.padEnd(14) + byDomain[d].length + ' 个 → ' + byDomain[d].join(', '));
  }

  console.log('');
  console.log('════ 识别口径（两通道 ✓）════');
  console.log('   ① 直调 client.request(\'x.y\')     = ' + directMethods.size + ' 个');
  console.log('   ② 字面串命中协议方法（动态分派） = ' + dynUsed.length + ' 个' + (dynUsed.length ? ' → ' + dynUsed.join(', ') : ''));

  console.log('');
  console.log('════ ① 协议有、前端**没用**（逐域）════');
  const unused = [...provided].filter((m) => !usedAll.has(m)).sort();
  const unusedByDomain = {};
  for (const m of unused) {
    const d = m.split('.')[0];
    (unusedByDomain[d] = unusedByDomain[d] || []).push(m.slice(d.length + 1));
  }
  for (const d of Object.keys(unusedByDomain).sort()) {
    const all = byDomain[d] || [];
    const used = all.filter((a) => usedAll.has(d + '.' + a));
    const flag = used.length === 0 ? '【整域未用】' : '';
    console.log('   ' + d.padEnd(14) + flag + ' 未用 ' + unusedByDomain[d].length + '/' + all.length + ' → ' + unusedByDomain[d].join(', '));
  }
  console.log('   小计：未用 ' + unused.length + ' / 共 ' + provided.size);

  console.log('');
  console.log('════ ② 前端在调、协议**没有**（必炸 ✗）════');
  const broken = [...directMethods].filter((m) => !provided.has(m)).sort();
  if (broken.length === 0) console.log('   ✓ 无（前端没调用不存在的方法）');
  else for (const m of broken) console.log('   ✗ ' + m);

  console.log('');
  console.log('════ ③ 事件：声明了、前端没有分支（收不到 ✗）════');
  const unhandled = [...declaredEvents].filter((ev) => !handledEvents.has(ev)).sort();
  if (unhandled.length === 0) console.log('   ✓ 无');
  else for (const ev of unhandled) console.log('   ✗ ' + ev);

  console.log('');
  console.log('════ ④ 前端在认、但协议未声明（幽灵分支）════');
  const ghosts = [...handledEvents].filter((ev) => ev.includes('.') && !declaredEvents.has(ev)).sort();
  if (ghosts.length === 0) console.log('   ✓ 无');
  else for (const ev of ghosts) console.log('   · ' + ev);

  console.log('');
  console.log('   合计：已接 ' + usedAll.size + '（直调 ' + directMethods.size + ' + 动态 ' + dynUsed.length + '）/ 协议 ' + provided.size);
  process.exit(0);
}, 1500);
